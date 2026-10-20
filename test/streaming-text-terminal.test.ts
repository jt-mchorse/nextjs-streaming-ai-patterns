/**
 * `streaming-text-client` reports a stream that ends without `event: done` as
 * an error, not as a finished answer (#142).
 *
 * The component ran its own read loop, ignored `event: done`, and set
 * `status = "done"` whenever the body ended -- so a cut stream (proxy timeout,
 * server crash, empty 200 body) rendered as complete: cursor gone, no error.
 * #138 had made the opposite rule for the two `pumpSseFrames` clients, and
 * `sse-stream-terminal.test.ts`'s "exactly the two clients that pump SSE" lock
 * could not see a component with its own loop.
 *
 * This repo has no component-render harness, so React's hooks are mocked:
 * `useState` records every setter call and `useEffect` runs the effect once.
 * The component's async body is then awaited by polling until a terminal
 * status is set.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { STREAM_TEXT_ENDED_WITHOUT_DONE } from "../lib/sse-stream";
import { sourceFiles, stripComments } from "./support/source-files";

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

const ROOT = resolve(__dirname, "..");
const enc = new TextEncoder();

/**
 * One chunk per read, then a clean EOF or -- `end: "reject"` -- a read that
 * rejects the way undici does when the socket closes mid-body (#196).
 */
function bodyOf(chunks: string[], end: "close" | "reject" = "close"): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else if (end === "close") controller.close();
      else controller.error(new TypeError("terminated"));
    },
  });
}

// Slots in declaration order: 0 text, 1 status, 2 errorMessage.
const TEXT_SLOT = 0;
const STATUS = 1;
const ERROR = 2;

async function drive(
  chunks: string[],
  end: "close" | "reject" = "close",
): Promise<{ statuses: unknown[]; errors: unknown[]; text: string }> {
  calls.length = 0;
  slot = 0;
  // The test transform compiles JSX to a bare `React.createElement`.
  vi.stubGlobal("React", { createElement: () => null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(bodyOf(chunks, end), { status: 200 })),
  );
  const { StreamingTextClient } = await import("../components/streaming-text-client");
  StreamingTextClient({ prompt: "hi" });
  const terminal = () =>
    calls.some((c) => c.slot === STATUS && (c.value === "done" || c.value === "error"));
  for (let i = 0; i < 200 && !terminal(); i++) await new Promise((r) => setTimeout(r, 1));
  // A late frame or rejection lands after the first terminal status; give it
  // the same window to show up rather than stopping at the first `done`.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
  // `setText` takes a functional updater; fold it to the rendered string.
  const text = calls
    .filter((c) => c.slot === TEXT_SLOT)
    .reduce<string>(
      (acc, c) => (typeof c.value === "function" ? (c.value as (p: string) => string)(acc) : String(c.value)),
      "",
    );
  return {
    statuses: calls.filter((c) => c.slot === STATUS).map((c) => c.value),
    errors: calls.filter((c) => c.slot === ERROR).map((c) => c.value),
    text,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEXT = 'data: {"text":"Hello"}\n\n';
const DONE = "event: done\ndata: {}\n\n";

describe("streaming-text-client terminal handling (#142)", () => {
  it("a body that ends without event: done is an error, not done", async () => {
    const { statuses, errors } = await drive([TEXT]);
    expect(statuses.at(-1)).toBe("error");
    expect(statuses).not.toContain("done");
    expect(errors.at(-1)).toBe(STREAM_TEXT_ENDED_WITHOUT_DONE);
  });

  it("an empty 200 body is an error, not done", async () => {
    const { statuses } = await drive([]);
    expect(statuses.at(-1)).toBe("error");
  });

  it("a stream that ends with event: done is still done (control)", async () => {
    const { statuses, errors } = await drive([TEXT, DONE]);
    expect(statuses.at(-1)).toBe("done");
    expect(errors.filter((e) => e !== null)).toEqual([]);
  });

  it("event: done split across chunks and CRLF-framed still counts", async () => {
    const { statuses } = await drive([TEXT.replace(/\n/g, "\r\n"), "event: do", "ne\r\ndata: {}\r\n\r\n"]);
    expect(statuses.at(-1)).toBe("done");
  });

  it("an event: error frame keeps its own message (control)", async () => {
    const { statuses, errors } = await drive([TEXT, 'event: error\ndata: {"error":"upstream 529"}\n\n']);
    expect(statuses.at(-1)).toBe("error");
    expect(errors.at(-1)).toBe("upstream 529");
  });
});

// #191 made a terminal phase final in the two pump clients; this loop kept
// reading and handling frames after `event: done`, so a later frame or a
// connection error overwrote a finished answer.
describe("streaming-text-client after event: done (#196)", () => {
  it("done then a clean EOF is done (control)", async () => {
    const { statuses, text } = await drive([TEXT, DONE], "close");
    expect(statuses).toEqual(["idle", "streaming", "done"]);
    expect(text).toBe("Hello");
  });

  it("done then a connection error is still done", async () => {
    const { statuses, errors } = await drive([TEXT, DONE], "reject");
    expect(statuses).toEqual(["idle", "streaming", "done"]);
    expect(errors.filter((e) => e !== null)).toEqual([]);
  });

  it.each([
    ["in a later read", [TEXT, DONE, 'data: {"text":" INJECTED"}\n\n']],
    ["in the same read", [TEXT, DONE + 'data: {"text":" INJECTED"}\n\n']],
  ])("a text frame after done is not rendered (%s)", async (_label, chunks) => {
    const { statuses, text } = await drive(chunks);
    expect(text).toBe("Hello");
    expect(statuses.at(-1)).toBe("done");
  });

  it("an error frame after done does not turn it into an error", async () => {
    const { statuses, errors } = await drive([TEXT, DONE, 'event: error\ndata: {"error":"late"}\n\n']);
    expect(statuses).toEqual(["idle", "streaming", "done"]);
    expect(errors.filter((e) => e !== null)).toEqual([]);
  });

  it("a connection error before done is still an error (control)", async () => {
    const { statuses, errors } = await drive([TEXT], "reject");
    expect(statuses.at(-1)).toBe("error");
    expect(errors.at(-1)).toBe("terminated");
  });
});

describe("every component with its own read loop checks for a terminal frame", () => {
  // `sse-stream-terminal.test.ts` locks the clients that call `pumpSseFrames`.
  // This is the other population: a component calling `reader.read()` itself.
  const ownLoop = sourceFiles("components").filter((p) =>
    /\.read\(\)/.test(stripComments(readFileSync(resolve(ROOT, p), "utf8"))),
  );

  it("finds streaming-text-client (non-zero control)", () => {
    expect(ownLoop.some((p) => p.endsWith("streaming-text-client.tsx"))).toBe(true);
  });

  it.each(ownLoop)("%s decides done from a terminal frame, not from the body ending", (p) => {
    const src = stripComments(readFileSync(resolve(ROOT, p), "utf8"));
    // The constant USED (thrown or set), not merely imported -- an import is
    // what a reverted check leaves behind. Or (error-recovery-client) a resume
    // when the body ends without `done`. Either way, not a silent `done`.
    expect(src).toMatch(
      /(throw new Error|setError|setErrorMessage)\(\s*(STREAM_TEXT_ENDED_WITHOUT_DONE|STREAM_ENDED_WITHOUT_TERMINAL)\s*\)|scheduleResume\(\)/,
    );
  });
});
