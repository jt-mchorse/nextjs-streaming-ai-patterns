/**
 * Every SSE reader in this repo must frame a body the same way (#106).
 *
 * `#95` fixed the separator scan in `pumpSseFrames`: the WHATWG SSE spec ends a
 * line with ANY of `\r\n`, `\n`, or `\r`, so the blank-line event separator has
 * three byte forms and `indexOf("\n\n")` finds exactly one of them. Four client
 * components read SSE; only two used `pumpSseFrames`. The other two —
 * `streaming-text-client` and `error-recovery-client` — carried their own
 * pre-`#95` loop, measured here against the same bodies:
 *
 *     body                          pumpSseFrames   streaming-text   error-recovery
 *     LF framing (control)          2 frame(s)      2 frame(s)       2 frame(s)
 *     CRLF framing                  2 frame(s)      0 frame(s)       0 frame(s)
 *     CR framing                    2 frame(s)      0 frame(s)       0 frame(s)
 *     LF, last frame unterminated   1 frame(s)      1 frame(s)       1 frame(s)
 *
 * Zero frames, and silently: the buffer accumulates every byte, the inner scan
 * never matches, the loop falls out on `done`. `streaming-text-client` then
 * called `setStatus("done")` on an empty pane; `error-recovery-client` fell
 * through to "connection closed mid-stream" and resumed forever against a
 * stream that was arriving fine.
 *
 * The assertions below are anchored to those measured counts, so a regression
 * has to bring a dropped frame back rather than merely stop matching a
 * separator. `does not re-inline the framing rules` is the check that would
 * have caught the gap when `#95` shipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSseFramer, pumpSseFrames } from "@/lib/sse-stream";

const encoder = new TextEncoder();

function readerOf(
  body: string,
  chunkSize = 4096,
): ReadableStreamDefaultReader<Uint8Array> {
  const bytes = encoder.encode(body);
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

/** The shape `pumpSseFrames` gives you. */
async function viaPump(body: string, chunkSize?: number): Promise<string[]> {
  const out: string[] = [];
  await pumpSseFrames(readerOf(body, chunkSize), (f) => out.push(f));
  return out;
}

/**
 * The shape a component with its own read loop gives you — the structure both
 * `streaming-text-client` and `error-recovery-client` now use. Kept here rather
 * than importing the components, which are React client components needing a
 * DOM, a fetch, and their own state machines; what is under test is the framing
 * contract they share, and this exercises the same two calls in the same order.
 */
async function viaFramerLoop(
  body: string,
  chunkSize?: number,
): Promise<string[]> {
  const out: string[] = [];
  const reader = readerOf(body, chunkSize);
  const decoder = new TextDecoder();
  const framer = createSseFramer();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const frame of framer.push(decoder.decode(value, { stream: true })))
      out.push(frame);
  }
  for (const frame of framer.flush()) out.push(frame);
  return out;
}

const twoFrames = (sep: string) =>
  `event: a${sep}data: {"i":1}${sep}${sep}event: b${sep}data: {"i":2}${sep}${sep}`;

// (label, body, expected frame count). The counts are the post-fix truth; the
// docstring records what the two clients produced before it.
const BODIES: ReadonlyArray<readonly [string, string, number]> = [
  ["LF framing (control)", twoFrames("\n"), 2],
  ["CRLF framing", twoFrames("\r\n"), 2],
  ["CR framing", twoFrames("\r"), 2],
  ["mixed LF and CRLF", `event: a\ndata: 1\n\nevent: b\r\ndata: 2\r\n\r\n`, 2],
  [
    "LF, last frame unterminated",
    'event: a\ndata: {"i":1}\n\nevent: b\ndata: {"i":2}',
    1,
  ],
  ["CR-terminated, no trailing blank", "event: a\rdata: 1\r\r event: b", 1],
  ["empty body", "", 0],
  ["separator only", "\n\n", 1],
];

describe("SSE framing parity", () => {
  it("the table covers more than the happy path", () => {
    expect(BODIES.length).toBeGreaterThanOrEqual(6);
    expect(
      BODIES.filter(([, body]) => body.includes("\r")).length,
    ).toBeGreaterThanOrEqual(3);
  });

  describe.each(BODIES)("%s", (label, body, expected) => {
    it(`pumpSseFrames yields ${expected} frame(s)`, async () => {
      expect(await viaPump(body)).toHaveLength(expected);
    });

    it(`a component's own read loop yields the same ${expected} frame(s)`, async () => {
      expect(await viaFramerLoop(body)).toHaveLength(expected);
    });

    it("both produce byte-identical frames", async () => {
      expect(await viaFramerLoop(body)).toEqual(await viaPump(body));
    });
  });

  // Chunk sizes chosen to straddle terminators: 1 puts every `\r` and `\n` in
  // its own read, which is the read-straddling case the framer's carry exists
  // for, and 3 lands mid-token on these bodies.
  describe.each([1, 3, 7, 4096])("read chunk size %i", (chunkSize) => {
    it.each(BODIES)(
      "%s frames identically regardless of chunking",
      async (label, body) => {
        const chunked = await viaPump(body, chunkSize);
        const whole = await viaPump(body, 4096);
        expect(chunked).toEqual(whole);
        expect(await viaFramerLoop(body, chunkSize)).toEqual(whole);
      },
    );
  });

  it("a \\r split across two reads does not manufacture a frame boundary", async () => {
    // `...\r` then `\n...` is ONE terminator, not two. Feeding it as two reads
    // is the only way to exercise the framer's carry.
    const framer = createSseFramer();
    expect(framer.push("event: a\ndata: 1\r")).toEqual([]);
    expect(framer.push("\nevent: b\ndata: 2\n\n")).toEqual([
      "event: a\ndata: 1\nevent: b\ndata: 2",
    ]);
    expect(framer.flush()).toEqual([]);
  });

  it("a trailing lone \\r is resolved by flush, not dropped", async () => {
    const framer = createSseFramer();
    expect(framer.push("event: a\ndata: 1\n\r")).toEqual([]);
    expect(framer.flush()).toEqual(["event: a\ndata: 1"]);
  });

  it("does not re-inline the framing rules in any component", () => {
    // The lock. `#95` fixed the separator scan in one place and two components
    // kept their own copies; nothing failed. A fifth client that pastes the
    // loop again fails here instead of silently discarding CRLF streams.
    const dir = join(process.cwd(), "components");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tsx") && !name.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, name), "utf8");
      // Strip block and line comments so the explanatory notes that *quote*
      // the old shape are not themselves flagged — a doc lock must not trip on
      // the prose explaining its own fix.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (
        /\.(indexOf|split|lastIndexOf)\(\s*["'`]\\n\\n["'`]\s*\)/.test(code)
      ) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
