/**
 * /api/stream-text ends a live stream in `event: done` only when the upstream
 * finished the answer (#167).
 *
 * The live path yielded text deltas and returned when the upstream body ended,
 * and the route then sent `event: done` -- the frame the client takes as proof
 * the answer is whole (#142). Measured on main against a loopback upstream:
 *
 *   stop_reason=max_tokens               -> 200 ... event: done
 *   upstream EOF after one delta         -> 200 ... event: done
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../app/api/stream-text/route";

const START =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"x","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Streaming beats waiting because the"}}\n\n';
const BLOCK_STOP = 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
const delta = (stop: string) =>
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stop}","stop_sequence":null},"usage":{"output_tokens":1}}\n\n`;
const MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

let server: Server;
let upstreamBody = "";
const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };

beforeEach(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(upstreamBody);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  for (const [k, v] of [
    ["ANTHROPIC_API_KEY", saved.key],
    ["ANTHROPIC_BASE_URL", saved.base],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function stream(body: string): Promise<string> {
  upstreamBody = body;
  const res = await GET(new Request("http://localhost/api/stream-text") as never);
  expect(res.status).toBe(200);
  return res.text();
}

const lastFrame = (sse: string) => sse.trim().split("\n\n").at(-1) ?? "";

describe("live stream terminal frame (#167)", () => {
  it.each(["max_tokens", "refusal", "pause_turn"])("stop_reason=%s ends in event: error naming it", async (stop) => {
    const sse = await stream(START + BLOCK_STOP + delta(stop) + MESSAGE_STOP);
    expect(sse).not.toContain("event: done");
    expect(lastFrame(sse)).toMatch(/^event: error\ndata: /);
    expect(lastFrame(sse)).toContain(`stop_reason=${stop}`);
  });

  it.each([
    ["after one delta", START],
    ["after the block stop", START + BLOCK_STOP],
    ["after message_delta, before message_stop", START + BLOCK_STOP + delta("end_turn")],
  ])("an upstream that ends %s ends in event: error", async (_label, body) => {
    const sse = await stream(body);
    expect(sse).not.toContain("event: done");
    expect(lastFrame(sse)).toContain("ended before message_stop");
  });

  it("the text that did arrive is still delivered before the error", async () => {
    const sse = await stream(START + BLOCK_STOP + delta("max_tokens") + MESSAGE_STOP);
    expect(sse.indexOf('data: {"text":"Streaming beats waiting because the"}')).toBe(0);
  });

  it.each(["end_turn", "stop_sequence"])("stop_reason=%s with message_stop ends in event: done", async (stop) => {
    const sse = await stream(START + BLOCK_STOP + delta(stop) + MESSAGE_STOP);
    expect(lastFrame(sse)).toBe("event: done\ndata: {}");
    expect(sse).not.toContain("event: error");
  });
});
