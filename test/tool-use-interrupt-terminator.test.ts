/**
 * What an Interrupt actually does on the wire (#204).
 *
 * README, docs/architecture.md, docs/tool-use-state-machine.md and the
 * `mockToolStream` docblock (served by the /tool-use source pane) all said the
 * client receives a `message_stop: interrupted` terminator. It cannot: the
 * client aborted its own fetch, so by the time the streamer yields that frame
 * the route's body is cancelled. The route then threw on the enqueue, threw
 * again enqueueing `event: error` from its catch, and a third time on `close()`.
 *
 * The route now drops every frame once `cancel()` has run. These tests pin
 * that, plus the reworded docs.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap the real streamer: fast delays, and a record of what it yielded and
// when it returned, so the test knows the route's start() loop has run out
// instead of guessing with a sleep.
const streamerLog = vi.hoisted(() => ({
  yielded: [] as Array<{ type: string; stop_reason?: string }>,
  finished: null as Promise<void> | null,
}));

vi.mock("@/lib/mock-tool-stream", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/mock-tool-stream")>();
  return {
    ...real,
    mockToolStream: (opts: Parameters<typeof real.mockToolStream>[0] = {}) => {
      let finish!: () => void;
      streamerLog.finished = new Promise<void>((r) => (finish = r));
      return (async function* () {
        try {
          for await (const ev of real.mockToolStream({ ...opts, baseDelayMs: 1, jitterMs: 0 })) {
            streamerLog.yielded.push(ev as { type: string; stop_reason?: string });
            yield ev;
          }
        } finally {
          finish();
        }
      })();
    },
  };
});

import { GET } from "../app/api/tool-use/route";

// Record every controller call that throws. A throw inside the route's
// `start()` is invisible to the client (the stream is already cancelled), so
// patching the prototype is the only way to see it.
const proto = ReadableStreamDefaultController.prototype;
const origEnqueue = proto.enqueue;
const origClose = proto.close;
let throws: string[] = [];

beforeEach(() => {
  throws = [];
  streamerLog.yielded = [];
  streamerLog.finished = null;
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
});

/** Read until `stopAt` appears (then abort + cancel, as the Interrupt button
 *  does) or until the body ends. Returns the `event:` names received. */
async function run(stopAt?: string): Promise<string[]> {
  const ac = new AbortController();
  const res = await GET(new NextRequest("http://localhost/api/tool-use", { signal: ac.signal }));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (stopAt && buf.includes(`event: ${stopAt}\n`)) {
      ac.abort();
      await reader.cancel();
      break;
    }
  }
  // Let the streamer return, then let the route's catch/finally run.
  await streamerLog.finished;
  await new Promise((r) => setTimeout(r, 0));
  return [...buf.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
}

describe("GET /api/tool-use — interrupt mid-stream (#204)", () => {
  it("drops the streamer's interrupted terminator without throwing on the closed stream", async () => {
    const events = await run("tool_use_start");
    // Anti-vacuity: the streamer DID yield the terminator the docs promised...
    expect(streamerLog.yielded.at(-1)).toEqual({ type: "message_stop", stop_reason: "interrupted" });
    // ...and the client never saw it, because it had already gone.
    expect(events.at(-1)).toBe("tool_use_start");
    expect(events).not.toContain("message_stop");
    // The route no-ops instead of throwing from enqueue, the catch, and close().
    expect(throws).toEqual([]);
  });

  it("control: an uninterrupted run still ends in message_stop end_turn with no throws", async () => {
    const events = await run();
    expect(events.at(-1)).toBe("message_stop");
    expect(streamerLog.yielded.at(-1)).toEqual({ type: "message_stop", stop_reason: "end_turn" });
    expect(throws).toEqual([]);
  });
});

describe("interrupt docs describe the real mechanism (#204)", () => {
  const ROOT = resolve(__dirname, "..");
  // Each phrase was the exact shape of a false claim on ac8d498.
  const BANNED: ReadonlyArray<[file: string, phrase: string]> = [
    ["README.md", "clean transcript with a `message_stop: interrupted` terminator"],
    ["docs/architecture.md", "a clean transcript ending in `message_stop: interrupted`"],
    ["docs/architecture.md", "The framer flush resolves a held-back lone"],
    ["lib/mock-tool-stream.ts", "The HTTP route forwards this to the client"],
    ["app/api/tool-use/route.ts", "streamer which yields a final `message_stop` with"],
  ];

  it.each(BANNED)("%s no longer says: %s", (file, phrase) => {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    expect(text).not.toContain(phrase);
  });

  // And the replacement says where `interrupted` really comes from.
  const REQUIRED: ReadonlyArray<[file: string, phrase: string]> = [
    ["README.md", "classifies its own `AbortError` as `interrupted`"],
    ["docs/architecture.md", "classifies its own `AbortError` as `interrupted`"],
    ["docs/tool-use-state-machine.md", "That terminator never reaches the client."],
    ["lib/mock-tool-stream.ts", "Over HTTP the client\n * never does"],
    ["app/api/tool-use/route.ts", "The client never receives a `message_stop: interrupted` frame"],
  ];

  it.each(REQUIRED)("%s says: %s", (file, phrase) => {
    expect(readFileSync(resolve(ROOT, file), "utf8")).toContain(phrase);
  });
});
