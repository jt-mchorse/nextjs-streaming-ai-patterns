/**
 * Cancellation wiring for the remaining SSE routes (#43, D-007), mirroring
 * `test/stream-text-route.test.ts` (#42).
 *
 * Each route now owns an AbortController, wires both `req.signal` and the
 * ReadableStream's `cancel()` into it, and passes its signal to the underlying
 * streamer. These tests run in mock mode (no ANTHROPIC_API_KEY needed — the
 * mock streamers and `streamCheckpoints` honor the signal), so there is no live
 * round-trip.
 *
 * `optimistic` is intentionally absent: it is a unary `POST` returning a single
 * `decide()` JSON, not a streaming `ReadableStream`, so there is nothing to
 * abort.
 */

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { GET as toolUseGET } from "../app/api/tool-use/route";
import { GET as partialJsonGET } from "../app/api/partial-json/route";
import { GET as errorRecoveryGET } from "../app/api/error-recovery/route";
import { streamCheckpoints, type StreamEvent } from "../lib/checkpoint-stream";

function parseSSE(blob: string): Array<{ event?: string; data: unknown }> {
  return blob
    .split("\n\n")
    .filter((s) => s.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      let event: string | undefined;
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        else if (line.startsWith("data: ")) data = line.slice("data: ".length);
      }
      return { event, data: data ? JSON.parse(data) : {} };
    });
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

// Content events (the actual work) vs. terminal/control events. An aborted
// stream may still emit a single terminal frame (message_stop interrupted, or
// the route's trailing `done`), but it must emit no content.
const CONTENT_EVENTS = new Set([
  "text_delta",
  "tool_use_start",
  "tool_use_delta",
  "tool_use_stop",
  "tool_result",
  "json_delta",
]);

describe("GET /api/tool-use — cancellation (#43)", () => {
  it("emits no content frames when the request is already aborted", async () => {
    const req = new NextRequest("http://localhost/api/tool-use", { signal: AbortSignal.abort() });
    const frames = parseSSE(await readAll(await toolUseGET(req)));
    expect(frames.filter((f) => f.event && CONTENT_EVENTS.has(f.event))).toEqual([]);
  });

  it("cancel() on the response body resolves cleanly mid-stream", async () => {
    const res = await toolUseGET(new NextRequest("http://localhost/api/tool-use"));
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await expect(reader.cancel()).resolves.toBeUndefined();
  });
});

describe("GET /api/partial-json — cancellation (#43)", () => {
  it("emits no json_delta frames when the request is already aborted", async () => {
    const req = new NextRequest("http://localhost/api/partial-json", {
      signal: AbortSignal.abort(),
    });
    const frames = parseSSE(await readAll(await partialJsonGET(req)));
    expect(frames.filter((f) => f.event && CONTENT_EVENTS.has(f.event))).toEqual([]);
  });

  it("cancel() on the response body resolves cleanly mid-stream", async () => {
    const res = await partialJsonGET(new NextRequest("http://localhost/api/partial-json"));
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await expect(reader.cancel()).resolves.toBeUndefined();
  });
});

describe("GET /api/error-recovery — cancellation (#43)", () => {
  it("emits no text/checkpoint frames when the request is already aborted", async () => {
    const req = new NextRequest("http://localhost/api/error-recovery?checkpoint=0", {
      signal: AbortSignal.abort(),
    });
    const frames = parseSSE(await readAll(await errorRecoveryGET(req)));
    // `streamCheckpoints` returns immediately on an aborted signal, so the only
    // frame is the route's trailing `done` — no `text`/`checkpoint` data frames.
    const dataFrames = frames.filter((f) => !f.event);
    expect(dataFrames).toEqual([]);
  });

  it("cancel() on the response body resolves cleanly mid-stream", async () => {
    const res = await errorRecoveryGET(
      new NextRequest("http://localhost/api/error-recovery?checkpoint=1"),
    );
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await expect(reader.cancel()).resolves.toBeUndefined();
  });
});

describe("streamCheckpoints — signal (#43)", () => {
  it("yields nothing when the signal is already aborted", async () => {
    const events: StreamEvent[] = [];
    for await (const ev of streamCheckpoints({ signal: AbortSignal.abort() })) {
      events.push(ev);
    }
    expect(events).toEqual([]);
  });

  it("stops yielding once the signal aborts mid-stream", async () => {
    const ac = new AbortController();
    const events: StreamEvent[] = [];
    for await (const ev of streamCheckpoints({ signal: ac.signal })) {
      events.push(ev);
      if (events.length === 3) ac.abort();
      if (events.length > 50) break; // safety cap — should never be hit
    }
    // Aborting after 3 events must stop it well short of the full fixture.
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.length).toBeLessThan(10);
  });
});
