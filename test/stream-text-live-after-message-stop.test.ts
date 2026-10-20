/**
 * /api/stream-text: once the upstream has sent `message_stop`, nothing the
 * connection does afterwards can turn the answer into an error (#202).
 *
 * #167 made `message_stop` + `end_turn`/`stop_sequence` the proof the answer
 * is whole, and #196/#200 made the clients stop reading at the terminal frame
 * so a late connection error cannot overwrite done. The server kept iterating
 * the SDK stream past `message_stop`, so the same late error reached it first.
 * Measured on main (feed037) against a loopback upstream that sends a complete
 * body and then destroys the socket 50 ms later:
 *
 *   [end]                        -> data: {"text":"Hello"}  event: done
 *   [destroy-after-message_stop] -> data: {"text":"Hello"}  event: error  data: {"error":"Premature close"}
 *
 * The same loop also hung the route for as long as an upstream held the socket
 * open after `message_stop`, and a `max_tokens` stop followed by a dead socket
 * reported "Premature close" instead of naming the stop_reason. The controls
 * pin the other side: a socket that dies BEFORE `message_stop` is still an
 * error, and a clean end is still done.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../app/api/stream-text/route";

const START =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"x","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n';
const BLOCK_STOP = 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
const delta = (stop: string) =>
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stop}","stop_sequence":null},"usage":{"output_tokens":1}}\n\n`;
const MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

type Ending = "end" | "destroy" | "hang";

let server: Server;
let upstreamBody = "";
let ending: Ending = "end";
const open = new Set<ServerResponse>();
const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };

beforeEach(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(upstreamBody);
      if (ending === "end") {
        res.end();
      } else if (ending === "destroy") {
        // The body is fully flushed; the socket then dies without a clean end.
        setTimeout(() => res.destroy(), 50);
      } else {
        // Keep the connection open with no further bytes.
        open.add(res);
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const res of open) res.destroy();
  open.clear();
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

async function stream(body: string, end: Ending): Promise<string> {
  upstreamBody = body;
  ending = end;
  const res = await GET(new Request("http://localhost/api/stream-text") as never);
  expect(res.status).toBe(200);
  return res.text();
}

const lastFrame = (sse: string) => sse.trim().split("\n\n").at(-1) ?? "";
const COMPLETE = START + BLOCK_STOP + delta("end_turn") + MESSAGE_STOP;

describe("live stream after message_stop (#202)", () => {
  it("a socket destroyed after message_stop still ends in event: done", async () => {
    const sse = await stream(COMPLETE, "destroy");
    expect(sse).toBe('data: {"text":"Hello"}\n\nevent: done\ndata: {}\n\n');
  });

  it("an upstream that holds the socket open after message_stop still ends in event: done", async () => {
    const sse = await stream(COMPLETE, "hang");
    expect(sse).toBe('data: {"text":"Hello"}\n\nevent: done\ndata: {}\n\n');
  }, 5_000);

  it("a socket destroyed after message_stop with stop_reason=max_tokens names the stop_reason", async () => {
    const sse = await stream(START + BLOCK_STOP + delta("max_tokens") + MESSAGE_STOP, "destroy");
    expect(sse).not.toContain("event: done");
    expect(lastFrame(sse)).toContain("stop_reason=max_tokens");
  });

  // Controls -- green before and after the fix.
  it("control: the same body with a clean end ends in event: done", async () => {
    const sse = await stream(COMPLETE, "end");
    expect(sse).toBe('data: {"text":"Hello"}\n\nevent: done\ndata: {}\n\n');
  });

  it("control: a socket destroyed after message_delta, before message_stop, is still event: error", async () => {
    const sse = await stream(START + BLOCK_STOP + delta("end_turn"), "destroy");
    expect(sse).not.toContain("event: done");
    expect(lastFrame(sse)).toMatch(/^event: error\ndata: /);
  });

  it("control: a socket destroyed after one delta is still event: error", async () => {
    const sse = await stream(START, "destroy");
    expect(sse).not.toContain("event: done");
    expect(lastFrame(sse)).toMatch(/^event: error\ndata: /);
  });
});
