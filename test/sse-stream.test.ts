/**
 * Unit tests for `lib/sse-stream.ts` (#60).
 *
 * The tool-use and partial-json clients used to inline an *unguarded* SSE read
 * loop, so an Interrupt (`AbortController.abort()`) rejected the in-flight
 * `reader.read()` with an `AbortError` that escaped `run()` — the component
 * never reached the documented `interrupted` terminal state and the UI wedged.
 * The loop now lives in `pumpSseFrames` and each client wraps it in a try/catch
 * that classifies the outcome with `isAbortError`. These tests exercise the
 * exact loop and the predicate the clients depend on.
 */
import { describe, expect, it } from "vitest";

import { isAbortError, pumpSseFrames } from "../lib/sse-stream";

const enc = new TextEncoder();

/** A reader that yields the given chunks (strings), then `done`. */
function readerOf(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0;
  return {
    read: async () =>
      i < chunks.length
        ? { value: enc.encode(chunks[i++]), done: false }
        : { value: undefined, done: true },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

/** A reader that yields `chunks`, then rejects with `err` (mid-stream abort). */
function readerThatRejects(
  chunks: string[],
  err: unknown,
): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0;
  return {
    read: async () => {
      if (i < chunks.length) return { value: enc.encode(chunks[i++]), done: false };
      throw err;
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe("isAbortError", () => {
  it("is true for a DOMException AbortError", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("is true for any abort-shaped object (cross-runtime / test doubles)", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });

  it("is false for a generic error, wrong name, or nullish", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(new TypeError("nope"))).toBe(false);
    expect(isAbortError({ name: "TypeError" })).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe("pumpSseFrames", () => {
  it("delivers each complete \\n\\n-framed frame in order", async () => {
    const frames: string[] = [];
    await pumpSseFrames(
      readerOf(["event: a\ndata: 1\n\n", "event: b\ndata: 2\n\n"]),
      (f) => frames.push(f),
    );
    expect(frames).toEqual(["event: a\ndata: 1", "event: b\ndata: 2"]);
  });

  it("reassembles a frame split across multiple reads", async () => {
    const frames: string[] = [];
    // One logical frame arrives in three pieces; a second frame trails.
    await pumpSseFrames(
      readerOf(["event: a\n", "data: hello\n", "\nevent: b\ndata: 2\n\n"]),
      (f) => frames.push(f),
    );
    expect(frames).toEqual(["event: a\ndata: hello", "event: b\ndata: 2"]);
  });

  it("does not emit a trailing partial frame with no terminator", async () => {
    const frames: string[] = [];
    await pumpSseFrames(readerOf(["event: a\ndata: 1\n\nleftover-no-term"]), (f) =>
      frames.push(f),
    );
    expect(frames).toEqual(["event: a\ndata: 1"]);
  });

  it("propagates an AbortError after delivering the frames read so far (#60 regression)", async () => {
    const frames: string[] = [];
    const abort = new DOMException("aborted", "AbortError");
    let caught: unknown;
    try {
      await pumpSseFrames(
        readerThatRejects(["event: a\ndata: 1\n\n"], abort),
        (f) => frames.push(f),
      );
      expect.unreachable("pumpSseFrames should reject when the reader aborts");
    } catch (e) {
      caught = e;
    }
    // The good frame before the abort was still delivered...
    expect(frames).toEqual(["event: a\ndata: 1"]);
    // ...and the abort propagated so the caller's catch maps it to `interrupted`.
    expect(isAbortError(caught)).toBe(true);
  });

  it("propagates a non-abort read error to the caller", async () => {
    const boom = new Error("network blip");
    let caught: unknown;
    try {
      await pumpSseFrames(readerThatRejects([], boom), () => {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
    expect(isAbortError(caught)).toBe(false);
  });
});
