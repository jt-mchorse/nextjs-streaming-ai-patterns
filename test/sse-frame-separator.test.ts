/**
 * `pumpSseFrames` must find every blank-line separator the SSE spec defines,
 * and must not drop the tail (#95).
 *
 * The pump split the read buffer on the literal string `"\n\n"`. The WHATWG
 * spec ends a line with ANY of `\r\n`, `\n`, or `\r`, so the event separator —
 * a blank line — has three byte forms, and `indexOf("\n\n")` finds exactly one
 * of them. A CRLF blank line is `\r \n \r \n`, which contains no adjacent
 * `\n\n`. Measured pre-fix:
 *
 *   LF, both terminated            -> 2 frames
 *   LF, last UNterminated          -> 1 frame   (tail dropped)
 *   LF, last ends single \n        -> 1 frame   (tail dropped)
 *   CRLF framing                   -> 0 frames  (entire stream discarded)
 *   CR framing                     -> 0 frames  (entire stream discarded)
 *
 * Every one of those is silent: no throw, no log, no state change. The pump
 * resolved successfully having called `onFrame` zero times, and the calling
 * component landed on its normal completion path with no content.
 *
 * What made this a live inconsistency rather than a speculative hardening:
 * `parseSseFrame` was deliberately hardened for CRLF in #93 ("under CRLF
 * framing the event name kept its `\r`"), and that fix could never fire,
 * because this layer could not deliver a CRLF frame for it to parse.
 *
 * Assertions are anchored to the measured pre-fix frame COUNTS, so a later
 * regression has to bring a dropped frame back rather than merely stop
 * matching a separator.
 */
import { describe, it, expect } from "vitest";

import { pumpSseFrames } from "../lib/sse-stream";

function readerOf(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return {
    async read() {
      return i < chunks.length
        ? { value: enc.encode(chunks[i++]), done: false }
        : { value: undefined, done: true };
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

async function framesFor(...chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  await pumpSseFrames(readerOf(chunks), (f) => out.push(f));
  return out;
}

const LF_BODY = "event: a\ndata: 1\n\nevent: b\ndata: 2\n\n";
const EXPECTED = ["event: a\ndata: 1", "event: b\ndata: 2"];

describe("pumpSseFrames — separator forms", () => {
  it("LF framing yields both frames (the case that always worked)", async () => {
    expect(await framesFor(LF_BODY)).toEqual(EXPECTED);
  });

  it("CRLF framing yields the same frames as its LF twin", async () => {
    // Pre-fix: 0 frames. Every byte accumulated in `buf` and was discarded.
    const crlf = LF_BODY.replace(/\n/g, "\r\n");
    expect(await framesFor(crlf)).toEqual(EXPECTED);
  });

  it("CR framing yields the same frames as its LF twin", async () => {
    // Pre-fix: 0 frames, same mechanism.
    const cr = LF_BODY.replace(/\n/g, "\r");
    expect(await framesFor(cr)).toEqual(EXPECTED);
  });
});

describe("pumpSseFrames — terminators straddling a read boundary", () => {
  it("an LF separator split across two reads still works (#60/#93 unregressed)", async () => {
    expect(
      await framesFor("event: a\ndata: 1\n", "\nevent: b\ndata: 2\n\n"),
    ).toEqual(EXPECTED);
  });

  it("a CRLF separator split exactly between its \\r and \\n still works", async () => {
    // This is the case the fix could most easily have broken. Normalizing a
    // chunk-final `\r` to `\n` in place would turn `...\r` + `\n...` into
    // `\n\n` and manufacture a boundary that isn't in the stream — so the
    // trailing `\r` is held back until the next read resolves it.
    const frames = await framesFor(
      "event: a\r\ndata: 1\r\n\r",
      "\nevent: b\r\ndata: 2\r\n\r\n",
    );
    expect(frames).toEqual(EXPECTED);
  });

  it("a chunk ending in \\r followed by a chunk starting with \\n is ONE terminator", async () => {
    // Same hazard from the other direction: two frames, not three.
    const frames = await framesFor(
      "event: a\ndata: 1\r",
      "\n\nevent: b\ndata: 2\n\n",
    );
    expect(frames).toEqual(EXPECTED);
  });

  it("a lone trailing \\r at end-of-stream is resolved as a terminator", async () => {
    // The held-back `\r` never got its `\n`, so it was a lone-CR terminator
    // after all. It must still separate the final frame rather than be lost
    // with the carry.
    expect(await framesFor("event: a\rdata: 1\r\r")).toEqual([
      "event: a\ndata: 1",
    ]);
  });
});

describe("pumpSseFrames — the tail", () => {
  it("still drops an unterminated trailing frame (existing named contract)", async () => {
    // NOT a defect, and this is the half of #95 that was built and then
    // REVERTED. `test/sse-stream.test.ts` has a named contract test — "does
    // not emit a trailing partial frame with no terminator" — and it is right:
    // an unterminated tail means the stream was truncated mid-frame, so
    // delivering it would hand `parseSseFrame` a payload whose `data:` is very
    // likely truncated JSON. Pinned here too, next to the separator tests, so
    // a future separator change can't quietly start flushing the tail.
    expect(await framesFor("event: a\ndata: 1\n\nevent: b\ndata: 2")).toEqual([
      "event: a\ndata: 1",
    ]);
  });

  it("drops the unterminated tail under CRLF framing too", async () => {
    // The normalization must not accidentally turn a truncated CRLF tail into
    // a delivered frame — the contract is about termination, not line endings.
    expect(
      await framesFor("event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2"),
    ).toEqual(["event: a\ndata: 1"]);
  });

  it("does NOT emit a spurious empty frame for a well-formed body", async () => {
    expect(await framesFor(LF_BODY)).toHaveLength(2);
  });

  it("emits nothing for an empty body", async () => {
    expect(await framesFor("")).toEqual([]);
    expect(await framesFor()).toEqual([]);
  });
});
