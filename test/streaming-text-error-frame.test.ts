/**
 * An `event: error` frame the client can't read shows "stream error" (#189).
 *
 * `streaming-text-client` parsed the payload inside a `try` whose `catch`
 * rethrew anything `instanceof Error` -- which `JSON.parse`'s `SyntaxError` and
 * `null.error`'s `TypeError` both are -- so its `throw new Error("stream error")`
 * was unreachable. Measured in a browser: `data: ` showed "Unexpected end of
 * JSON input", `data: null` "Cannot read properties of null (reading 'error')".
 *
 * Same harness as `streaming-text-terminal.test.ts`: React's hooks are mocked,
 * `useState` records every setter call and `useEffect` runs the effect once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Call = { slot: number; value: unknown };
const calls: Call[] = [];
let slot = 0;

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const mine = slot++;
    calls.push({ slot: mine, value: initial });
    return [initial, (v: unknown) => calls.push({ slot: mine, value: v })];
  },
  useEffect: (fn: () => void) => {
    fn();
  },
}));

const enc = new TextEncoder();
// Slots in declaration order: 0 text, 1 status, 2 errorMessage.
const STATUS = 1;
const ERROR = 2;

async function drive(chunks: string[]): Promise<{ status: unknown; error: unknown }> {
  calls.length = 0;
  slot = 0;
  vi.stubGlobal("React", { createElement: () => null });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200 })),
  );
  const { StreamingTextClient } = await import("../components/streaming-text-client");
  StreamingTextClient({ prompt: "hi" });
  const terminal = () =>
    calls.some((c) => c.slot === STATUS && (c.value === "done" || c.value === "error"));
  for (let i = 0; i < 200 && !terminal(); i++) await new Promise((r) => setTimeout(r, 1));
  const last = (s: number) => calls.filter((c) => c.slot === s).at(-1)?.value;
  return { status: last(STATUS), error: last(ERROR) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEXT = 'data: {"text":"Hello"}\n\n';
const errorFrame = (dataLine: string) => `event: error\n${dataLine}\n\n`;

describe("an unreadable error payload falls back to 'stream error'", () => {
  it.each([
    ["empty", "data: "],
    ["null", "data: null"],
    ["not JSON", "data: upstream overloaded"],
    ["numeric error", 'data: {"error": 5}'],
    ["object error", 'data: {"error": {"message": "overloaded"}}'],
    ["empty-string error", 'data: {"error": ""}'],
    ["no error key", 'data: {"message": "overloaded"}'],
    ["a JSON array", "data: []"],
  ])("%s", async (_label, dataLine) => {
    const { status, error } = await drive([TEXT, errorFrame(dataLine)]);
    expect(status).toBe("error");
    expect(error).toBe("stream error");
  });
});

describe("the route's own error payload still shows its message (control)", () => {
  it('{"error": "upstream overloaded"}', async () => {
    const { status, error } = await drive([
      TEXT,
      errorFrame('data: {"error":"upstream overloaded"}'),
    ]);
    expect(status).toBe("error");
    expect(error).toBe("upstream overloaded");
  });
});
