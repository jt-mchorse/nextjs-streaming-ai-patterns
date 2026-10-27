/**
 * No SSE route writes onto a stream its client has cancelled (#208).
 *
 * #204 fixed this in `app/api/tool-use/route.ts`. `partial-json`,
 * `stream-text` and `error-recovery` had the same `start()` shape: an
 * unguarded `controller.enqueue` in the loop and the catch, and an unguarded
 * `controller.close()` in `finally`. Once the client cancels the body, each of
 * those throws `Invalid state: Controller is already closed`, so every client
 * disconnect rejected the route's `start()` promise three times, and the
 * catch's `event: error` frame was dead code on that path. Measured on
 * c572321 (read 3 chunks, then abort + cancel):
 *
 *   partial-json   enqueue event: message_stop, enqueue event: error, close
 *   stream-text    enqueue event: done,         enqueue event: error, close
 *   error-recovery enqueue data: {"kind":"text",...}, enqueue event: error, close
 *
 * None of it reaches the client (it has gone), so the only way to see it is
 * to patch the controller prototype and record the throws.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap each route's real streamer: a record of whether the route's cancel()
// had already run when the streamer returned, and a promise that settles when
// it does, so a test knows the route's loop has run out instead of guessing
// with a sleep. Delays are cut to 1 ms where the streamer takes them.
const log = vi.hoisted(() => ({
  cancelled: false,
  finished: null as Promise<void> | null,
  finishedAfterCancel: false,
}));

async function* tracked<T>(gen: AsyncIterable<T>): AsyncGenerator<T, void, unknown> {
  let finish!: () => void;
  log.finished = new Promise<void>((r) => (finish = r));
  try {
    yield* gen;
  } finally {
    log.finishedAfterCancel = log.cancelled;
    finish();
  }
}

vi.mock("@/lib/mock-tool-stream", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/mock-tool-stream")>();
  return {
    ...real,
    mockToolStream: (opts: Parameters<typeof real.mockToolStream>[0] = {}) =>
      tracked(real.mockToolStream({ ...opts, baseDelayMs: 1, jitterMs: 0 })),
  };
});

vi.mock("@/lib/mock-json-stream", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/mock-json-stream")>();
  return {
    ...real,
    mockJsonStream: (opts: Parameters<typeof real.mockJsonStream>[0] = {}) =>
      tracked(real.mockJsonStream({ ...opts, baseDelayMs: 1, jitterMs: 0 })),
  };
});

vi.mock("@/lib/anthropic-stream", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/anthropic-stream")>();
  return {
    ...real,
    streamText: (...args: Parameters<typeof real.streamText>) => tracked(real.streamText(...args)),
  };
});

vi.mock("@/lib/checkpoint-stream", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/checkpoint-stream")>();
  return {
    ...real,
    streamCheckpoints: (opts: Parameters<typeof real.streamCheckpoints>[0] = {}) =>
      tracked(real.streamCheckpoints({ ...opts, baseDelayMs: 1, jitterMs: 0 })),
  };
});

import { GET as errorRecoveryGET } from "../app/api/error-recovery/route";
import { GET as partialJsonGET } from "../app/api/partial-json/route";
import { GET as streamTextGET } from "../app/api/stream-text/route";
import { GET as toolUseGET } from "../app/api/tool-use/route";

const proto = ReadableStreamDefaultController.prototype;
const origEnqueue = proto.enqueue;
const origClose = proto.close;
let throws: string[] = [];

beforeEach(() => {
  // Mock mode: stream-text must not reach for a live key.
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  throws = [];
  log.cancelled = false;
  log.finished = null;
  log.finishedAfterCancel = false;
  proto.enqueue = function (this: ReadableStreamDefaultController, chunk?: unknown) {
    try {
      return origEnqueue.call(this, chunk);
    } catch (e) {
      const head = new TextDecoder().decode(chunk as Uint8Array).split("\n")[0];
      throws.push(`enqueue ${head}: ${(e as Error).message}`);
      throw e;
    }
  };
  proto.close = function (this: ReadableStreamDefaultController) {
    try {
      return origClose.call(this);
    } catch (e) {
      throws.push(`close: ${(e as Error).message}`);
      throw e;
    }
  };
});

afterEach(() => {
  proto.enqueue = origEnqueue;
  proto.close = origClose;
  vi.unstubAllEnvs();
});

type Route = (req: NextRequest) => Promise<Response>;

/** Read `cancelAfter` chunks then abort + cancel (as the UI's Stop/Interrupt
 *  does), or read to the end when it is omitted. Returns the raw body read. */
async function run(get: Route, url: string, cancelAfter?: number): Promise<string> {
  const ac = new AbortController();
  const res = await get(new NextRequest(url, { signal: ac.signal }));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let body = "";
  for (let n = 1; ; n++) {
    const { done, value } = await reader.read();
    if (done) break;
    body += decoder.decode(value, { stream: true });
    if (cancelAfter !== undefined && n >= cancelAfter) {
      log.cancelled = true;
      ac.abort();
      await reader.cancel();
      break;
    }
  }
  // Let the streamer return, then let the route's catch/finally run.
  await log.finished;
  await new Promise((r) => setTimeout(r, 0));
  return body;
}

const ROUTES: ReadonlyArray<[name: string, get: Route, url: string, terminal: RegExp]> = [
  ["tool-use", toolUseGET, "http://localhost/api/tool-use", /event: message_stop\ndata: \{"stop_reason":"end_turn"\}\n\n$/],
  ["partial-json", partialJsonGET, "http://localhost/api/partial-json", /event: message_stop\ndata: \{"stop_reason":"end_turn"\}\n\n$/],
  ["stream-text", streamTextGET, "http://localhost/api/stream-text", /event: done\ndata: \{\}\n\n$/],
  // checkpoint=1 is a resume request, which never drops, so it ends in `done`.
  ["error-recovery", errorRecoveryGET, "http://localhost/api/error-recovery?checkpoint=1", /event: done\ndata: \{\}\n\n$/],
];

describe.each(ROUTES)("GET /api/%s — client cancels mid-stream (#208)", (_name, get, url, terminal) => {
  it("writes nothing onto the cancelled stream: no enqueue or close throws", async () => {
    await run(get, url, 3);
    // Anti-vacuity: the route's loop was still live when the client left, so
    // its post-cancel enqueue/catch/close code did run on a closed stream.
    expect(log.finishedAfterCancel).toBe(true);
    expect(throws).toEqual([]);
  });

  it("control: an uninterrupted run still ends in its terminal frame with no throws", async () => {
    const body = await run(get, url);
    expect(body).toMatch(terminal);
    expect(log.finishedAfterCancel).toBe(false);
    expect(throws).toEqual([]);
  });
});

describe("GET /api/error-recovery — the simulated drop still reaches the client (#208)", () => {
  it("control: a fresh request ends in its `event: error` drop frame with no throws", async () => {
    const body = await run(errorRecoveryGET, "http://localhost/api/error-recovery?checkpoint=0");
    expect(body).toMatch(/event: error\ndata: \{"reason":"stream dropped after 12 text tokens \(simulated\)","last_token":12\}\n\n$/);
    expect(throws).toEqual([]);
  });
});
