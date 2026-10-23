/**
 * `error-recovery-client` cancels its reader on a terminal frame (#220).
 *
 * `pumpSseFramesToTerminal`'s docstring and #196 both said the pump cancels the
 * reader on its terminal frame, "which is what `error-recovery-client` already
 * did on `done`". It did not: its hand-rolled loop stopped *reading* on `done`
 * but never called `reader.cancel()`, so the response body stayed open until
 * the server closed it. On main, against a body that sends its frames and then
 * holds the socket open:
 *
 *   text, done, held open   -> phase "done", body cancelled 0 times
 *   text, error, held open  -> resumes, first body cancelled 0 times
 *
 * The client now reads through the shared pump, which cancels on the terminal
 * frame. React's hooks are mocked as in `error-recovery-terminal-frames.test.ts`.
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

interface Body {
  readonly response: Response;
  /** Times the underlying source saw `cancel` — the connection being released. */
  cancels: number;
}

/**
 * One chunk per read; then `held` never resolves another read (the #196/#202
 * held-open shape: the server keeps the socket up after its terminal frame),
 * `close` ends the body, `reject` errors it like undici's "terminated".
 */
function body(chunks: string[], end: "held" | "close" | "reject"): Body {
  let i = 0;
  const b: Body = {
    cancels: 0,
    response: new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
          else if (end === "close") controller.close();
          else if (end === "reject") controller.error(new TypeError("terminated"));
          else return new Promise<void>(() => {});
        },
        cancel() {
          b.cancels++;
        },
      }),
      { status: 200 },
    ),
  };
  return b;
}

const HELLO = 'data: {"kind":"text","index":1,"text":"Hello"}\n\n';
const DONE = "event: done\ndata: {}\n\n";
const ERROR = 'event: error\ndata: {"reason":"upstream overloaded","last_token":1}\n\n';
const RESUMED = ['data: {"kind":"text","index":2,"text":" world"}\n\n', DONE];

async function drive(first: string[], end: "held" | "close" | "reject") {
  state.length = 0;
  slot = 0;
  vi.stubGlobal("React", { createElement: () => null });
  const unhandled: string[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(String((e as Error)?.message ?? e));
  process.on("unhandledRejection", onUnhandled);
  const bodies: Body[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      // A resume is held open too, so its `done` has to be cancelled as well.
      const b = bodies.length === 0 ? body(first, end) : body(RESUMED, "held");
      bodies.push(b);
      return b.response;
    }),
  );
  try {
    const { ErrorRecoveryClient } = await import("../components/error-recovery-client");
    ErrorRecoveryClient();
    const settled = () =>
      (state[PHASE] === "done" || state[PHASE] === "fatal") &&
      (end !== "held" || bodies.every((b) => b.cancels > 0));
    for (let i = 0; i < 200 && !settled(); i++) await new Promise((r) => setTimeout(r, 5));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return {
    phase: state[PHASE],
    text: state[TEXT],
    reason: state[REASON],
    recoveries: state[COUNT],
    cancels: bodies.map((b) => b.cancels),
    unhandled,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("error-recovery cancels its reader on a terminal frame (#220)", () => {
  it("done on a held-open body is done, and the body is cancelled", async () => {
    const r = await drive([HELLO, DONE], "held");
    expect(r).toEqual({
      phase: "done",
      text: "Hello",
      reason: null,
      recoveries: 0,
      cancels: [1],
      unhandled: [],
    });
  });

  it("done in the same chunk as text, held open, is cancelled", async () => {
    const r = await drive([HELLO + DONE], "held");
    expect(r.phase).toBe("done");
    expect(r.cancels).toEqual([1]);
  });

  it("an error frame on a held-open body cancels it, then resumes", async () => {
    const r = await drive([HELLO, ERROR], "held");
    expect(r).toEqual({
      phase: "done",
      text: "Hello world",
      reason: "upstream overloaded",
      recoveries: 1,
      cancels: [1, 1],
      unhandled: [],
    });
  });

  // Controls: the paths the pump must not change.
  it("done then close is done, with no resume (control)", async () => {
    const r = await drive([HELLO, DONE], "close");
    expect(r.phase).toBe("done");
    expect(r.recoveries).toBe(0);
    expect(r.unhandled).toEqual([]);
  });

  it("a body that closes without a terminal frame resumes as mid-stream (control)", async () => {
    const r = await drive([HELLO], "close");
    expect(r.phase).toBe("done");
    expect(r.text).toBe("Hello world");
    expect(r.recoveries).toBe(1);
    expect(r.reason).toBe("connection closed mid-stream");
    expect(r.cancels[0]).toBe(0);
  });

  it("a read that rejects before a terminal frame resumes as a connection error (control)", async () => {
    const r = await drive([HELLO], "reject");
    expect(r.phase).toBe("done");
    expect(r.text).toBe("Hello world");
    expect(r.recoveries).toBe(1);
    expect(r.reason).toBe("connection error: terminated");
  });
});
