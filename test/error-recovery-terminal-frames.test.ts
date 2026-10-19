/**
 * `error-recovery-client` acts on a terminal frame by its event name even when
 * its data is unreadable, and skips only non-terminal frames whose data is not
 * a JSON object (#193, the contract #191 set for the other clients).
 *
 * On main, after one text token "Hello":
 *
 *   event: error / data: null                  -> phase "streaming" forever, 1 request,
 *                                                 unhandled "Cannot read properties of null (reading 'reason')"
 *   data: null, then done                      -> phase "streaming" forever, 1 request,
 *                                                 unhandled "Cannot read properties of null (reading 'kind')"
 *   event: error / data: upstream overloaded,  -> phase "done", 0 recoveries, no reason:
 *   then done                                     the truncated answer read as finished
 *
 * React's hooks are mocked as in `error-recovery-resume-claim.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const state: unknown[] = [];
let slot = 0;

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const mine = slot++;
    state[mine] = initial;
    return [
      initial,
      (v: unknown) => {
        state[mine] = typeof v === "function" ? (v as (p: unknown) => unknown)(state[mine]) : v;
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (fn: () => void) => {
    fn();
  },
}));

// Slots in declaration order: 0 text, 1 phase, 2 lastResume, 3 recoveryReason,
// 4 recoveryCount.
const TEXT = 0;
const PHASE = 1;
const REASON = 3;
const COUNT = 4;

const enc = new TextEncoder();

function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const HELLO = 'data: {"kind":"text","index":1,"text":"Hello"}\n\n';
const DONE = "event: done\ndata: {}\n\n";
const RESUMED = ['data: {"kind":"text","index":2,"text":" world"}\n\n', DONE];

async function drive(first: string[]) {
  state.length = 0;
  slot = 0;
  vi.stubGlobal("React", { createElement: () => null });
  const unhandled: string[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(String((e as Error)?.message ?? e));
  process.on("unhandledRejection", onUnhandled);
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return urls.length === 1 ? sse(first) : sse(RESUMED);
    }),
  );
  try {
    const { ErrorRecoveryClient } = await import("../components/error-recovery-client");
    ErrorRecoveryClient();
    const terminal = () => state[PHASE] === "done" || state[PHASE] === "fatal";
    for (let i = 0; i < 200 && !terminal(); i++) await new Promise((r) => setTimeout(r, 5));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return {
    phase: state[PHASE],
    text: state[TEXT],
    reason: state[REASON],
    recoveries: state[COUNT],
    urls,
    unhandled,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("error-recovery terminal frames with unreadable data (#193)", () => {
  it("the route's own error frame resumes from its last_token with its reason (control)", async () => {
    const r = await drive([
      HELLO,
      'event: error\ndata: {"reason":"upstream overloaded","last_token":1}\n\n',
    ]);
    expect(r).toEqual({
      phase: "done",
      text: "Hello world",
      reason: "upstream overloaded",
      recoveries: 1,
      urls: ["/api/error-recovery?checkpoint=0", "/api/error-recovery?checkpoint=1"],
      unhandled: [],
    });
  });

  it("an error frame with {} data resumes with 'unknown server-side error' (control)", async () => {
    const r = await drive([HELLO, "event: error\ndata: {}\n\n"]);
    expect(r.phase).toBe("done");
    expect(r.reason).toBe("unknown server-side error");
    expect(r.recoveries).toBe(1);
  });

  it.each([
    ["null", "data: null"],
    ["not JSON", "data: upstream overloaded"],
    ["a number", "data: 5"],
    ["an array", "data: []"],
    ["empty", "data: "],
    ["an object with a numeric reason", 'data: {"reason": 5}'],
  ])(
    "an error frame whose data is %s resumes with 'unknown server-side error'",
    async (_label, dataLine) => {
      const r = await drive([HELLO, `event: error\n${dataLine}\n\n`]);
      expect(r).toEqual({
        phase: "done",
        text: "Hello world",
        reason: "unknown server-side error",
        recoveries: 1,
        urls: ["/api/error-recovery?checkpoint=0", "/api/error-recovery?checkpoint=1"],
        unhandled: [],
      });
    },
  );

  it("an unreadable error frame followed by done still resumes, not done-as-truncated", async () => {
    const r = await drive([HELLO, "event: error\ndata: upstream overloaded\n\n", DONE]);
    expect(r.urls).toHaveLength(2);
    expect(r.recoveries).toBe(1);
    expect(r.reason).toBe("unknown server-side error");
    expect(r.text).toBe("Hello world");
  });

  it.each([
    ["null", "data: null"],
    ["not JSON", "data: garbled"],
    ["an array", "data: []"],
  ])("a text frame whose data is %s is skipped and the stream finishes", async (_label, dataLine) => {
    const r = await drive([HELLO, `${dataLine}\n\n`, DONE]);
    expect(r).toEqual({
      phase: "done",
      text: "Hello",
      reason: null,
      recoveries: 0,
      urls: ["/api/error-recovery?checkpoint=0"],
      unhandled: [],
    });
  });

  it("a done frame whose data is null ends at done", async () => {
    const r = await drive([HELLO, "event: done\ndata: null\n\n"]);
    expect(r.phase).toBe("done");
    expect(r.urls).toHaveLength(1);
    expect(r.unhandled).toEqual([]);
  });
});
