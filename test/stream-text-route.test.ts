/**
 * Tests for `app/api/stream-text/route.ts` cancellation wiring (#42, D-007).
 *
 * These exercise the route in mock mode (no ANTHROPIC_API_KEY), so there is no
 * live SDK round-trip — the mock streamer honors the same `AbortSignal` the
 * route now plumbs through `streamText`.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../app/api/stream-text/route";

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

describe("GET /api/stream-text — cancellation (#42)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // mock mode
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("emits no text frames and closes when the request is already aborted", async () => {
    // A disconnected client surfaces as an aborted request signal. The route
    // wires `req.signal` into its AbortController, so `streamText` sees the
    // abort immediately and yields nothing — only the trailing `done` event.
    const req = new NextRequest("http://localhost/api/stream-text?prompt=hello", {
      signal: AbortSignal.abort(),
    });
    const res = await GET(req);
    const frames = parseSSE(await readAll(res));

    const textFrames = frames.filter((f) => !f.event);
    expect(textFrames).toEqual([]);
    expect(frames.some((f) => f.event === "done")).toBe(true);
  });

  it("cancel() on the response body resolves cleanly mid-stream", async () => {
    const res = await GET(new NextRequest("http://localhost/api/stream-text?prompt=hello"));
    const reader = res.body!.getReader();

    // Pull the first chunk, then cancel like a browser hitting "Stop".
    const first = await reader.read();
    expect(first.done).toBe(false);

    // Must not throw or hang — the route's cancel() aborts its controller.
    await expect(reader.cancel()).resolves.toBeUndefined();
  });
});
