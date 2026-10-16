/**
 * A live text delta reaches the client when the upstream sends it, not one
 * upstream event later (#183).
 *
 * `@anthropic-ai/sdk` 0.32.1–0.36.3 split SSE chunks with a loop bounded at
 * `buffer.length - 2`, so a `\n\n` that *ended* a network chunk was never seen
 * and that event waited in the buffer for the next chunk. The API sends about
 * one event per chunk, so every delta was held until the next event arrived.
 * Measured on main against a loopback upstream writing one event per 400 ms:
 *
 *   delta A: arrived 403 ms after the upstream wrote it   (0.32.1)
 *   delta A: arrived 1 ms after the upstream wrote it     (0.37.0)
 *
 * `stream-text-live-terminal.test.ts` sends its whole body in one `res.end()`,
 * and the SDK flushes at EOF, so it saw every frame and none of the delay. This
 * upstream writes one event at a time and then holds the connection open, so a
 * held-back event never comes out unless the test lets the upstream go on.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../app/api/stream-text/route";

const ev = (name: string, payload: object) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
const textDelta = (text: string) =>
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });

const OPENING = [
  ev("message_start", {
    type: "message_start",
    message: {
      id: "m",
      type: "message",
      role: "assistant",
      content: [],
      model: "x",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }),
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
];
const CLOSING =
  ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
  ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  }) +
  ev("message_stop", { type: "message_stop" });

// Long enough that a held-back frame cannot be mistaken for a slow one, and
// well inside vitest's 5 s default.
const HELD_BACK_MS = 1500;

let server: Server;
let upstream: Promise<ServerResponse>;
const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };

beforeEach(async () => {
  let connected!: (res: ServerResponse) => void;
  upstream = new Promise((resolve) => (connected = resolve));
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      connected(res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  for (const [k, v] of [
    ["ANTHROPIC_API_KEY", saved.key],
    ["ANTHROPIC_BASE_URL", saved.base],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** The route's next SSE frame, or `null` if none arrives within `HELD_BACK_MS`. */
function nextFrameReader(body: ReadableStream<Uint8Array>): () => Promise<string | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  return async () => {
    const deadline = Date.now() + HELD_BACK_MS;
    while (!buf.includes("\n\n")) {
      pending ??= reader.read();
      const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), Math.max(0, deadline - Date.now())));
      const got = await Promise.race([pending, timer]);
      if (got === "timeout") return null;
      pending = null;
      if (got.done) return null;
      buf += decoder.decode(got.value, { stream: true });
    }
    const end = buf.indexOf("\n\n");
    const frame = buf.slice(0, end);
    buf = buf.slice(end + 2);
    return frame;
  };
}

describe("live text deltas are not held back (#183)", () => {
  it("each delta's frame goes out while the upstream is still waiting to send the next event", async () => {
    const res = await GET(new Request("http://localhost/api/stream-text") as never);
    expect(res.status).toBe(200);
    const nextFrame = nextFrameReader(res.body!);
    const up = await upstream;

    for (const e of OPENING) up.write(e);
    for (const text of ["Streaming ", "beats waiting"]) {
      up.write(textDelta(text));
      // Nothing more is written until this frame is read: a chunker that waits
      // for the next chunk's bytes never releases it.
      expect(await nextFrame()).toBe(`data: ${JSON.stringify({ text })}`);
    }

    up.end(CLOSING);
    expect(await nextFrame()).toBe("event: done\ndata: {}");
  });

  it("a delta and its terminator split across two writes still go out at the terminator", async () => {
    const res = await GET(new Request("http://localhost/api/stream-text") as never);
    const nextFrame = nextFrameReader(res.body!);
    const up = await upstream;

    for (const e of OPENING) up.write(e);
    const whole = textDelta("split");
    up.write(whole.slice(0, -1));
    expect(await nextFrame()).toBeNull(); // one `\n` is not a frame end
    up.write("\n");
    expect(await nextFrame()).toBe(`data: ${JSON.stringify({ text: "split" })}`);

    up.end(CLOSING);
    expect(await nextFrame()).toBe("event: done\ndata: {}");
  });
});
