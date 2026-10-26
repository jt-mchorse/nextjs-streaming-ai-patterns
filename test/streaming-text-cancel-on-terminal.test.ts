/**
 * `streaming-text-client` cancels its reader on `event: error`, as on `done`
 * (#226).
 *
 * #196 made `done` stop the read loop and call `reader.cancel()`. An `error`
 * frame left the loop a different way: `handleFrame` threw, which jumped
 * straight to the `catch` and skipped that `cancel()`, so the response body
 * stayed open until the server closed it -- the "terminal frame but no cancel"
 * shape #220 fixed in `error-recovery-client`. On main, against a body that
 * sends its frames and then holds the socket open:
 *
 *   text, done, held open   -> status "done",  body cancelled 1 time
 *   text, error, held open  -> status "error", body cancelled 0 times
 *
 * React's hooks are mocked as in `streaming-text-terminal.test.ts`.
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
const TEXT_SLOT = 0;
const STATUS = 1;
const ERROR = 2;

/**
 * One chunk per read; then `held` never resolves another read (the server
 * keeps the socket up after its terminal frame), `close` ends the body.
 */
async function drive(chunks: string[], end: "held" | "close") {
  calls.length = 0;
  slot = 0;
  vi.stubGlobal("React", { createElement: () => null });
  let i = 0;
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else if (end === "close") controller.close();
      else return new Promise<void>(() => {});
    },
    cancel() {
      cancels++;
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
  for (let n = 0; n < 200 && !terminal(); n++) await new Promise((r) => setTimeout(r, 1));
  // A cancel issued alongside the terminal status gets the same window.
  for (let n = 0; n < 20; n++) await new Promise((r) => setTimeout(r, 1));
  const text = calls
    .filter((c) => c.slot === TEXT_SLOT)
    .reduce<string>(
      (acc, c) => (typeof c.value === "function" ? (c.value as (p: string) => string)(acc) : String(c.value)),
      "",
    );
  return {
    statuses: calls.filter((c) => c.slot === STATUS).map((c) => c.value),
    error: calls.filter((c) => c.slot === ERROR).at(-1)?.value,
    text,
    cancels,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEXT = 'data: {"text":"Hello"}\n\n';
const DONE = "event: done\ndata: {}\n\n";
const ERROR_FRAME = 'event: error\ndata: {"error":"upstream 529"}\n\n';
const LATE_TEXT = 'data: {"text":" INJECTED"}\n\n';

describe("streaming-text-client cancels its reader on event: error (#226)", () => {
  it("error on a held-open body is an error, and the body is cancelled", async () => {
    const r = await drive([TEXT, ERROR_FRAME], "held");
    expect(r).toEqual({
      statuses: ["idle", "streaming", "error"],
      error: "upstream 529",
      text: "Hello",
      cancels: 1,
    });
  });

  it("error in the same chunk as text, held open, is cancelled", async () => {
    const r = await drive([TEXT + ERROR_FRAME], "held");
    expect(r.statuses.at(-1)).toBe("error");
    expect(r.error).toBe("upstream 529");
    expect(r.cancels).toBe(1);
  });

  it("an unreadable error payload is still terminal and cancelled", async () => {
    const r = await drive([TEXT, "event: error\ndata: \n\n"], "held");
    expect(r.statuses.at(-1)).toBe("error");
    expect(r.error).toBe("stream error");
    expect(r.cancels).toBe(1);
  });

  it("a text frame after error in the same read is not rendered", async () => {
    const r = await drive([TEXT, ERROR_FRAME + LATE_TEXT], "held");
    expect(r.text).toBe("Hello");
    expect(r.statuses.at(-1)).toBe("error");
  });

  it("done on a held-open body is done, and cancelled once (control)", async () => {
    const r = await drive([TEXT, DONE], "held");
    expect(r).toEqual({
      statuses: ["idle", "streaming", "done"],
      error: null,
      text: "Hello",
      cancels: 1,
    });
  });

  it("an error frame on a body that then closes keeps its message (control)", async () => {
    const r = await drive([TEXT, ERROR_FRAME], "close");
    expect(r.statuses.at(-1)).toBe("error");
    expect(r.error).toBe("upstream 529");
  });
});
