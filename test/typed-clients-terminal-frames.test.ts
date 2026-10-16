/**
 * A terminal frame with unreadable data still ends the run, and ends it once
 * (#191).
 *
 * `partial-json-client` and `tool-use-client` cast `JSON.parse(data)` to an
 * object and skipped the frame on a parse error whatever its event was. On
 * main, both clients identically:
 *
 *   event: error / data: null                -> "Cannot read properties of null (reading 'error')"
 *   event: message_stop / data: null         -> "Cannot read properties of null (reading 'stop_reason')"
 *   event: error / data: upstream overloaded -> "stream ended before a terminal frame"
 *   ...that frame, then a message_stop       -> phase done, no error
 *
 * React's hooks are mocked as in `streaming-text-terminal.test.ts`: `useState`
 * records every setter call, and the run callback `useCallback` returns is
 * invoked directly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Call = { slot: number; value: unknown };
const calls: Call[] = [];
let slot = 0;
let callbacks: Array<() => Promise<void>> = [];

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const mine = slot++;
    calls.push({ slot: mine, value: initial });
    return [
      initial,
      (v: unknown) => calls.push({ slot: mine, value: typeof v === "function" ? "<fn>" : v }),
    ];
  },
  useEffect: () => {},
  useRef: (v: unknown) => ({ current: v }),
  useCallback: (fn: () => Promise<void>) => {
    callbacks.push(fn);
    return fn;
  },
}));

const enc = new TextEncoder();

// Slots in declaration order. partial-json: 0 phase, 1 parsed, 2 isComplete,
// 3 bufferLen, 4 error. tool-use: 0 phase, 1 timeline, 2 error. The run
// callback is the first useCallback in partial-json and the third in tool-use.
const CLIENTS = {
  "partial-json": { phase: 0, error: 4, run: 0 },
  "tool-use": { phase: 0, error: 2, run: 2 },
} as const;
type Client = keyof typeof CLIENTS;

async function drive(client: Client, body: string): Promise<{ phase: unknown; error: unknown }> {
  calls.length = 0;
  slot = 0;
  callbacks = [];
  vi.stubGlobal("React", { createElement: () => null });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(body));
      controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(stream, { status: 200 })),
  );
  if (client === "partial-json") {
    const { PartialJsonClient } = await import("../components/partial-json-client");
    PartialJsonClient();
  } else {
    const { ToolUseClient } = await import("../components/tool-use-client");
    ToolUseClient();
  }
  const { phase, error, run } = CLIENTS[client];
  await callbacks[run]();
  const last = (s: number) => calls.filter((c) => c.slot === s).at(-1)?.value;
  return { phase: last(phase), error: last(error) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const STOP = 'event: message_stop\ndata: {"stop_reason":"end_turn"}\n\n';

describe.each(Object.keys(CLIENTS) as Client[])("%s client (#191)", (client) => {
  it("the route's own error payload shows its message (control, and the slot map)", async () => {
    expect(await drive(client, 'event: error\ndata: {"error":"upstream overloaded"}\n\n')).toEqual({
      phase: "error",
      error: "upstream overloaded",
    });
  });

  it.each([
    ["null", "data: null"],
    ["not JSON", "data: upstream overloaded"],
    ["a number", "data: 5"],
    ["an array", "data: []"],
    ["empty", "data: "],
    ["a numeric error field", 'data: {"error": 5}'],
  ])("an error frame whose data is %s ends at error, 'unknown error'", async (_label, dataLine) => {
    expect(await drive(client, `event: error\n${dataLine}\n\n`)).toEqual({
      phase: "error",
      error: "unknown error",
    });
  });

  it.each([
    ["null", "data: null"],
    ["not JSON", "data: garbled"],
  ])("a message_stop whose data is %s ends at done", async (_label, dataLine) => {
    const { phase } = await drive(client, `event: message_stop\n${dataLine}\n\n`);
    expect(phase).toBe("done");
  });

  it("an unreadable error frame followed by a message_stop stays an error", async () => {
    expect(await drive(client, `event: error\ndata: upstream overloaded\n\n${STOP}`)).toEqual({
      phase: "error",
      error: "unknown error",
    });
  });

  it("a readable error frame followed by a message_stop stays an error too", async () => {
    const { phase } = await drive(client, `event: error\ndata: {"error":"boom"}\n\n${STOP}`);
    expect(phase).toBe("error");
  });

  it("an unreadable non-terminal frame is still skipped (control)", async () => {
    const delta = client === "partial-json" ? "json_delta" : "text_delta";
    expect((await drive(client, `event: ${delta}\ndata: garbled\n\n${STOP}`)).phase).toBe("done");
  });
});
