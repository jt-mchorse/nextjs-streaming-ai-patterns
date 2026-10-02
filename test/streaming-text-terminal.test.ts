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

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

// Slots in declaration order: 0 text, 1 status, 2 errorMessage.
const STATUS = 1;
const ERROR = 2;

async function drive(chunks: string[]): Promise<{ statuses: unknown[]; errors: unknown[] }> {
  calls.length = 0;
  slot = 0;
  // The test transform compiles JSX to a bare `React.createElement`.
  vi.stubGlobal("React", { createElement: () => null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(bodyOf(chunks), { status: 200 })),
  );
  const { StreamingTextClient } = await import("../components/streaming-text-client");
  StreamingTextClient({ prompt: "hi" });
  const terminal = () =>
    calls.some((c) => c.slot === STATUS && (c.value === "done" || c.value === "error"));
  for (let i = 0; i < 200 && !terminal(); i++) await new Promise((r) => setTimeout(r, 1));
  return {
    statuses: calls.filter((c) => c.slot === STATUS).map((c) => c.value),
    errors: calls.filter((c) => c.slot === ERROR).map((c) => c.value),
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
