/**
 * A stream that ends without a terminal frame is an error, not a wedge (#138).
 *
 * `partial-json-client` and `tool-use-client` set their terminal phases only
 * from inside the frame handler, on `message_stop` or `error`. When the body
 * ended cleanly without one -- complete frames, no terminal frame, or an empty
 * body -- `pumpSseFrames` resolved normally and nothing ran after it, so the
 * phase stayed `streaming` / `connecting` for good: Run disabled, Interrupt
 * inert (the fetch had already finished). Reproduced against the running app
 * with Playwright route interception before the fix. #60 closed the same wedge
 * on the *reject* side only.
 *
 * This repo has no component-render harness (see
 * `streaming-client-cleanup.test.ts`), so the lib function is tested for
 * behaviour and the two clients are locked at the source level.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { pumpSseFramesToTerminal, STREAM_ENDED_WITHOUT_TERMINAL } from "../lib/sse-stream";
import { sourceFiles, stripComments } from "./support/source-files";

const enc = new TextEncoder();
const ROOT = resolve(__dirname, "..");

/** `reads` / `cancels` count calls, so a test can see the pump stop (#196). */
type CountingReader = ReadableStreamDefaultReader<Uint8Array> & { reads: number; cancels: number };

function readerOf(chunks: string[]): CountingReader {
  let i = 0;
  const r = {
    reads: 0,
    cancels: 0,
    read: async () => {
      r.reads++;
      return i < chunks.length
        ? { value: enc.encode(chunks[i++]), done: false }
        : { value: undefined, done: true };
    },
    cancel: async () => {
      r.cancels++;
    },
  };
  return r as unknown as CountingReader;
}

function readerThatRejects(chunks: string[], err: unknown): CountingReader {
  let i = 0;
  const r = {
    reads: 0,
    cancels: 0,
    read: async () => {
      r.reads++;
      if (i < chunks.length) return { value: enc.encode(chunks[i++]), done: false };
      throw err;
    },
    // A cancel that rejects too: the pump must not surface it.
    cancel: async () => {
      r.cancels++;
      throw err;
    },
  };
  return r as unknown as CountingReader;
}

/** A handler shaped like the clients': terminal on a parseable stop/error frame. */
function clientLikeHandler(seen: string[]): (frame: string) => boolean {
  return (frame) => {
    seen.push(frame);
    const event = /^event: ?(.*)$/m.exec(frame)?.[1] ?? "message";
    const data = /^data: ?(.*)$/m.exec(frame)?.[1] ?? "";
    if (!data) return false;
    try {
      JSON.parse(data);
    } catch {
      return false;
    }
    return event === "message_stop" || event === "error";
  };
}

describe("pumpSseFramesToTerminal", () => {
  it("resolves true when the handler reaches a terminal phase", async () => {
    const seen: string[] = [];
    const reached = await pumpSseFramesToTerminal(
      readerOf(['event: json_delta\ndata: {"delta":"{"}\n\n', 'event: message_stop\ndata: {}\n\n']),
      clientLikeHandler(seen),
    );
    expect(reached).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("resolves false on a clean end with complete frames and no terminal one", async () => {
    const seen: string[] = [];
    const reached = await pumpSseFramesToTerminal(
      readerOf(['event: json_delta\ndata: {"delta":"{"}\n\n']),
      clientLikeHandler(seen),
    );
    expect(reached).toBe(false);
    // Every frame was still delivered: the wrapper observes, it does not filter.
    expect(seen).toHaveLength(1);
  });

  it("resolves false on an empty body", async () => {
    expect(await pumpSseFramesToTerminal(readerOf([]), clientLikeHandler([]))).toBe(false);
  });

  it("counts an `error` frame the handler accepts as terminal", async () => {
    const reached = await pumpSseFramesToTerminal(
      readerOf(['event: error\ndata: {"error":"boom"}\n\n']),
      clientLikeHandler([]),
    );
    expect(reached).toBe(true);
  });

  it("does not count an `error` frame the handler skips -- the handler decides, not the name", async () => {
    // Both clients drop a frame whose JSON does not parse, so this frame puts
    // them in no terminal phase. A name match would call it terminal and keep
    // the wedge.
    const reached = await pumpSseFramesToTerminal(
      readerOf(["event: error\ndata: {not json\n\n"]),
      clientLikeHandler([]),
    );
    expect(reached).toBe(false);
  });

  it("stays true once reached, whatever follows", async () => {
    const reached = await pumpSseFramesToTerminal(
      readerOf(["event: message_stop\ndata: {}\n\n", 'event: json_delta\ndata: {"delta":"x"}\n\n']),
      clientLikeHandler([]),
    );
    expect(reached).toBe(true);
  });

  it("handles CRLF framing the same way", async () => {
    const reached = await pumpSseFramesToTerminal(
      readerOf(["event: message_stop\r\ndata: {}\r\n\r\n"]),
      clientLikeHandler([]),
    );
    expect(reached).toBe(true);
  });

  // #196: #191 filtered frames after the terminal one but kept reading, so a
  // connection error after `message_stop` rejected into the caller's catch.
  it("does not read again after the terminal frame, and cancels the reader", async () => {
    const reader = readerOf(["event: message_stop\ndata: {}\n\n", "event: json_delta\ndata: {}\n\n"]);
    expect(await pumpSseFramesToTerminal(reader, clientLikeHandler([]))).toBe(true);
    expect(reader.reads).toBe(1);
    expect(reader.cancels).toBe(1);
  });

  it("resolves true when the read after the terminal frame would reject", async () => {
    const reader = readerThatRejects(["event: message_stop\ndata: {}\n\n"], new TypeError("terminated"));
    expect(await pumpSseFramesToTerminal(reader, clientLikeHandler([]))).toBe(true);
    expect(reader.reads).toBe(1);
  });

  it("does not deliver a frame that shares the terminal frame's chunk", async () => {
    const seen: string[] = [];
    await pumpSseFramesToTerminal(
      readerOf(['event: message_stop\ndata: {}\n\nevent: json_delta\ndata: {"delta":"x"}\n\n']),
      clientLikeHandler(seen),
    );
    expect(seen).toHaveLength(1);
  });

  it("reads to EOF and never cancels when no frame is terminal (control)", async () => {
    const reader = readerOf(['event: json_delta\ndata: {"delta":"{"}\n\n']);
    expect(await pumpSseFramesToTerminal(reader, clientLikeHandler([]))).toBe(false);
    expect(reader.reads).toBe(2);
    expect(reader.cancels).toBe(0);
  });

  it("still rejects on an abort, so #60's `interrupted` classification is unchanged", async () => {
    const abort = new DOMException("aborted", "AbortError");
    await expect(
      pumpSseFramesToTerminal(readerThatRejects(["event: json_delta\ndata: {}\n\n"], abort), () => false),
    ).rejects.toBe(abort);
  });
});

// ----------------------------------------------------------------------
// The two clients, at the source level
// ----------------------------------------------------------------------

function clientsUsingTheSseLib(): string[] {
  return sourceFiles("components").filter((path) =>
    /from\s+"@\/lib\/sse-stream"/.test(readFileSync(resolve(ROOT, path), "utf8")),
  );
}

function caseBody(src: string, name: string): string {
  const start = src.indexOf(`case "${name}": {`);
  expect(start, `no case "${name}"`).toBeGreaterThan(-1);
  const next = src.indexOf("case ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("streaming clients that pump SSE", () => {
  const pumping = clientsUsingTheSseLib().filter((p) =>
    /pumpSseFrames/.test(stripComments(readFileSync(resolve(ROOT, p), "utf8"))),
  );

  it("are exactly the two this issue is about (non-zero control)", () => {
    expect(pumping.map((p) => relative(ROOT, resolve(ROOT, p))).sort()).toEqual([
      "components/partial-json-client.tsx",
      "components/tool-use-client.tsx",
    ]);
  });

  it.each(["components/partial-json-client.tsx", "components/tool-use-client.tsx"])(
    "%s never calls the raw pump, and turns a non-terminal end into an error",
    (rel) => {
      const src = stripComments(readFileSync(resolve(ROOT, rel), "utf8"));
      expect(src).not.toMatch(/\bpumpSseFrames\s*\(/);
      expect(src).toMatch(
        /if\s*\(\s*!\s*\(\s*await\s+pumpSseFramesToTerminal\(reader,\s*handleFrame\)\s*\)\s*\)\s*\{\s*setError\(STREAM_ENDED_WITHOUT_TERMINAL\);\s*setPhase\("error"\);/,
      );
    },
  );

  it.each(["components/partial-json-client.tsx", "components/tool-use-client.tsx"])(
    "%s reports terminal exactly on message_stop and error",
    (rel) => {
      const src = stripComments(readFileSync(resolve(ROOT, rel), "utf8"));
      expect(caseBody(src, "message_stop")).toMatch(/return true;/);
      expect(caseBody(src, "error")).toMatch(/return true;/);
      // Nothing else in the handler claims a terminal phase.
      const handler = src.slice(src.indexOf("function handleFrame"));
      expect(handler.match(/return true;/g)).toHaveLength(2);
    },
  );
});

it("the message names the cause", () => {
  expect(STREAM_ENDED_WITHOUT_TERMINAL).toMatch(/message_stop/);
});
