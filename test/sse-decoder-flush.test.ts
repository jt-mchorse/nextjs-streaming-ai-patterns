/**
 * Every SSE read path flushes its `TextDecoder`, not just its framer (#115, D-013).
 *
 * `TextDecoder.decode(bytes, { stream: true })` holds back a trailing incomplete
 * UTF-8 sequence, waiting for the rest of it. If the body ends mid-codepoint
 * those bytes are never emitted at all — the argument-less `decode()` is what
 * releases them, as `U+FFFD`. All three read paths made the streaming call and
 * never the flushing one.
 *
 * This file is deliberately shaped as a **measurement**, because the honest
 * answer to "does this matter" is layered:
 *
 * 1. At the decoder, the difference is real and is measured here:
 *    `"data: caf"` vs `"data: caf�"`.
 * 2. At the frame, the difference is **nil today**, and that is measured too —
 *    exhaustively, over every byte-truncation of a table of bodies. The held
 *    bytes only exist when the stream ended mid-codepoint, which means the
 *    framer is holding an unterminated tail, which `flush()` deliberately drops.
 *
 * So this is not a bug fix, and the tests do not pretend it is. It is here
 * because it is free, because (2) proves it is safe rather than merely hoped to
 * be, and because #97 is open about whether a truncated tail should surface as
 * an error. If #97 ever says yes, `U+FFFD` is the evidence — and it has to have
 * survived to be it. The equivalence assertion below is also the tripwire: the
 * day `flush()` starts emitting the remainder, it goes red and points here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSseFramer } from "@/lib/sse-stream";
import { readSourceFiles, SOURCE_DIRS } from "./support/source-files";

const encoder = new TextEncoder();

function readerOf(
  bytes: Uint8Array,
  chunkSize: number,
): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0;
  return {
    read: async () => {
      if (i >= bytes.length) return { done: true, value: undefined };
      const value = bytes.slice(i, i + chunkSize);
      i += chunkSize;
      return { done: false, value };
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

/** The read loop as it is now: decoder flush, then framer flush. */
async function readFrames(
  bytes: Uint8Array,
  chunkSize: number,
): Promise<string[]> {
  const decoder = new TextDecoder();
  const framer = createSseFramer();
  const out: string[] = [];
  const reader = readerOf(bytes, chunkSize);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const f of framer.push(decoder.decode(value, { stream: true })))
      out.push(f);
  }
  for (const f of framer.push(decoder.decode())) out.push(f);
  for (const f of framer.flush()) out.push(f);
  return out;
}

/** The read loop as it was: framer flush only. Kept so the delta is a row. */
async function readFramesWithoutDecoderFlush(
  bytes: Uint8Array,
  chunkSize: number,
): Promise<string[]> {
  const decoder = new TextDecoder();
  const framer = createSseFramer();
  const out: string[] = [];
  const reader = readerOf(bytes, chunkSize);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const f of framer.push(decoder.decode(value, { stream: true })))
      out.push(f);
  }
  for (const f of framer.flush()) out.push(f);
  return out;
}

describe("the decoder holds bytes back, and the flush releases them", () => {
  it("drops a truncated multi-byte character without the flush", () => {
    const full = encoder.encode("data: café");
    const truncated = full.slice(0, full.length - 1); // cut mid-é

    const streamed = new TextDecoder().decode(truncated, { stream: true });
    expect(streamed).toBe("data: caf");

    const flushing = new TextDecoder();
    expect(flushing.decode(truncated, { stream: true })).toBe("data: caf");
    expect(flushing.decode()).toBe("�");
  });

  it("holds a codepoint split across two reads until the second one", () => {
    // The ordinary, non-truncated case the `{ stream: true }` flag exists for.
    // Present so "the decoder holds bytes" is not read as "the decoder is
    // lossy" — it is only lossy when nothing follows.
    const bytes = encoder.encode("é");
    const decoder = new TextDecoder();
    expect(decoder.decode(bytes.slice(0, 1), { stream: true })).toBe("");
    expect(decoder.decode(bytes.slice(1), { stream: true })).toBe("é");
    expect(decoder.decode()).toBe("");
  });

  it("emits nothing extra when the stream ended on a codepoint boundary", () => {
    // Anti-vacuous partner: if the flush emitted something on a *clean* stream,
    // adding it to three read loops would be injecting garbage rather than
    // recovering evidence.
    const decoder = new TextDecoder();
    expect(decoder.decode(encoder.encode("data: café\n\n"), { stream: true })).toBe(
      "data: café\n\n",
    );
    expect(decoder.decode()).toBe("");
  });
});

// Bodies chosen to straddle the framer's hard cases: all three separator forms,
// a lone-CR terminator (the one shape `framer.flush()` must resolve), and
// multibyte payloads so a truncation can actually land mid-codepoint.
const BODIES: ReadonlyArray<readonly [string, string]> = [
  ["LF framing, multibyte payload", 'data: {"t":"café"}\n\ndata: {"t":"中文"}\n\n'],
  ["CRLF framing, multibyte payload", 'data: {"t":"café"}\r\n\r\ndata: {"t":"中"}\r\n\r\n'],
  ["CR framing, multibyte payload", 'data: {"t":"café"}\r\rdata: {"t":"中"}\r\r'],
  ["trailing lone CR after a frame", "data: a\n\ndata: café\r"],
  ["unterminated multibyte tail", "data: a\n\ndata: 中"],
  ["multibyte only, no terminator", "café中文"],
  ["separator then multibyte", "\n\n中"],
  ["empty", ""],
];

const CHUNK_SIZES = [1, 2, 3, 5, 4096];

describe("adding the decoder flush changes no frame today", () => {
  it("the body table exercises the framer's hard cases", () => {
    // Anti-vacuous: an equivalence over bodies that cannot be truncated
    // mid-codepoint would hold trivially.
    expect(BODIES.length).toBeGreaterThanOrEqual(6);
    expect(
      BODIES.filter(([, b]) => encoder.encode(b).length !== b.length).length,
    ).toBeGreaterThanOrEqual(5);
    expect(BODIES.filter(([, b]) => b.includes("\r")).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it.each(BODIES)(
    "%s: identical frames at every truncation and chunk size",
    async (label, body) => {
      const full = encoder.encode(body);
      let compared = 0;
      for (let cut = 0; cut <= full.length; cut++) {
        const bytes = full.slice(0, cut);
        for (const chunkSize of CHUNK_SIZES) {
          const withFlush = await readFrames(bytes, chunkSize);
          const without = await readFramesWithoutDecoderFlush(bytes, chunkSize);
          expect(withFlush, `${label} cut=${cut} chunk=${chunkSize}`).toEqual(
            without,
          );
          compared += 1;
        }
      }
      // The loop has to have run: a zero-length body would otherwise "pass"
      // this row while comparing one trivial case.
      expect(compared).toBe((full.length + 1) * CHUNK_SIZES.length);
    },
  );

  it("at least one truncation actually lands mid-codepoint", async () => {
    // The measurement that gives the equivalence above its meaning: without a
    // truncation the decoder holds back on, the equivalence is about nothing.
    const body = 'data: {"t":"café"}\n\n';
    const full = encoder.encode(body);
    const midCodepointCuts: number[] = [];
    for (let cut = 0; cut <= full.length; cut++) {
      const decoder = new TextDecoder();
      decoder.decode(full.slice(0, cut), { stream: true });
      if (decoder.decode() !== "") midCodepointCuts.push(cut);
    }
    expect(midCodepointCuts.length).toBeGreaterThan(0);
  });
});

describe("every SSE read path flushes its decoder", () => {
  /** Same comment-stripping rule `sse-framing-parity.test.ts` uses. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  /**
   * The population this lock scans (#118).
   *
   * Was a private listing of `["lib", "components"]`, one level deep. That
   * misses two things: `app/`, where every SSE route handler lives and where a
   * route proxying an upstream stream would decode one; and any subdirectory
   * of `lib/` or `components/`, since `readdirSync` returns one level. Both
   * were confirmed by dropping a non-flushing decoder into `app/api/` and into
   * `lib/sub/` and watching this file stay green.
   *
   * `readSourceFiles` is the repo's shared answer, recursive over
   * `SOURCE_DIRS` — the same walk `architecture-doc.test.ts` uses. Shared
   * rather than copied: two locks with two populations is how the partial
   * adoption in #114 slipped past the guard that was supposed to see it.
   */
  function sourceFiles(root?: string): Array<readonly [string, string]> {
    return readSourceFiles(root);
  }

  it("no file decodes with { stream: true } without also flushing", () => {
    // Stated positively — what must be PRESENT — for the reason
    // `sse-framing-parity.test.ts` spells out: a negatively-stated rule ("must
    // not do X") is satisfied by a file that does nothing, which is how a
    // partial adoption passes (#114).
    //
    // `decode()` with no arguments is the flush; the regex requires an empty
    // argument list so `decode(value)` cannot satisfy it.
    const streaming: string[] = [];
    const offenders: string[] = [];
    for (const [path, src] of sourceFiles()) {
      const code = stripComments(src);
      if (!/\.decode\([^)]*\{\s*stream:\s*true\s*\}/.test(code)) continue;
      streaming.push(path);
      if (!/\.decode\(\s*\)/.test(code)) offenders.push(path);
    }
    // Anti-vacuous, and specific: a scan that matched nothing would satisfy the
    // assertion below while checking nothing, and the whole point of #115 is
    // that there are exactly three of these and one is easy to forget.
    expect(streaming.sort()).toEqual([
      "components/error-recovery-client.tsx",
      "components/streaming-text-client.tsx",
      "lib/sse-stream.ts",
    ]);
    expect(offenders).toEqual([]);
  });

  // The population is the thing #118 was about, so it gets its own assertions
  // against real files on disk rather than reasoning about the walk. Each probe
  // is the exact defect this lock exists to catch — a decoder using
  // `{ stream: true }` that never makes the argument-less call — planted where
  // the old private listing could not see it.
  const PROBE = [
    "export async function probe(body: ReadableStream<Uint8Array>) {",
    "  const reader = body.getReader();",
    "  const decoder = new TextDecoder();",
    "  let out = '';",
    "  for (;;) {",
    "    const { done, value } = await reader.read();",
    "    if (done) break;",
    "    out += decoder.decode(value, { stream: true });",
    "  }",
    "  return out;",
    "}",
  ].join("\n");

  /** Build a throwaway tree with the repo's source dirs and one planted file. */
  function treeWith(relPath: string): string {
    const root = mkdtempSync(join(tmpdir(), "flush-lock-"));
    for (const dir of SOURCE_DIRS) mkdirSync(join(root, dir), { recursive: true });
    const abs = join(root, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, PROBE, "utf8");
    return root;
  }

  it.each([
    ["a route handler under app/", "app/api/upstream-proxy/route.ts"],
    ["a nested module under lib/", "lib/streaming/decode.ts"],
    ["a nested component", "components/panels/live-feed.tsx"],
  ])("finds a non-flushing decoder in %s", (_label, relPath) => {
    // Both of the first two were verified against the pre-#118 listing by
    // planting them in the real tree: the lock passed 14/14 and never saw
    // either. `app/` was absent from the dir list, and `readdirSync` returned
    // one level so nothing nested was reachable.
    const root = treeWith(relPath);
    try {
      const found = sourceFiles(root).map(([path]) => path);
      expect(found).toContain(relPath);

      const offenders = sourceFiles(root)
        .filter(([, src]) => /\.decode\([^)]*\{\s*stream:\s*true\s*\}/.test(stripComments(src)))
        .filter(([, src]) => !/\.decode\(\s*\)/.test(stripComments(src)))
        .map(([path]) => path);
      expect(offenders).toEqual([relPath]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans app/, which is where a stream-proxying route handler would decode", () => {
    // Stated separately from the probes because it is true of the *real* tree
    // and needs no fixture: today `app/` contributes files to the population
    // even though none of them decodes yet. That is the difference between a
    // guard that would catch the next one and a guard that would not.
    const scanned = sourceFiles().map(([path]) => path);
    expect(scanned.some((p) => p.startsWith("app/"))).toBe(true);
    expect(scanned.some((p) => p.startsWith("app/api/"))).toBe(true);
  });
});
