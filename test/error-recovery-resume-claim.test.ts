/**
 * `error-recovery-client` claims a resume only once the resumed request has
 * connected (#158).
 *
 * The "resumed at token N" pill and the recovery count used to be set in
 * `scheduleResume`, when the drop was detected. That is 250 ms before the
 * resume request is sent, and it happened whether or not that request ever
 * connected. Measured in a browser with the resume request refused: the header
 * read "fatal error · 1 recovery · resumed at token 12" for about 2.25 s. During
 * the back-off the phase also stayed "streaming" although nothing was streaming.
 *
 * This repo has no component-render harness, so React's hooks are mocked the
 * way `streaming-text-terminal.test.ts` mocks them. `useState` keeps a real
 * value per slot and applies functional updaters. `useRef` is a plain object.
 * `useEffect` runs its effect once. The component is called once, and its async
 * body is polled until it reaches a terminal phase.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Call = { slot: number; value: unknown };
const calls: Call[] = [];
const state: unknown[] = [];
let slot = 0;

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const mine = slot++;
    state[mine] = initial;
    return [
      initial,
      (v: unknown) => {
        const next = typeof v === "function" ? (v as (p: unknown) => unknown)(state[mine]) : v;
        state[mine] = next;
        calls.push({ slot: mine, value: next });
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
const PHASE = 1;
const LAST_RESUME = 2;
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

/** Two tokens, then the route's simulated-drop `error` frame at token 2. */
const DROPPED = [
  'data: {"kind":"text","index":1,"text":"Hello"}\n\n',
  'data: {"kind":"text","index":2,"text":" world"}\n\n',
  'event: error\ndata: {"reason":"stream dropped after 2 text tokens (simulated)","last_token":2}\n\n',
];

const RESUMED_OK = ['data: {"kind":"text","index":3,"text":"!"}\n\n', "event: done\ndata: {}\n\n"];

type Second = "ok" | "reject" | "503";

async function drive(second: Second) {
  calls.length = 0;
  state.length = 0;
  slot = 0;
  vi.stubGlobal("React", { createElement: () => null });
  const urls: string[] = [];
  // Which phase is on screen while the back-off timer runs: read when the
  // component schedules the 250 ms reconnect.
  let phaseDuringBackoff: unknown = undefined;
  const realSetTimeout = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
    if (ms === 250) phaseDuringBackoff = state[PHASE];
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      if (urls.length === 1) return sse(DROPPED);
      if (second === "reject") throw new TypeError("Failed to fetch");
      if (second === "503") return new Response("down", { status: 503 });
      return sse(RESUMED_OK);
    }),
  );
  const { ErrorRecoveryClient } = await import("../components/error-recovery-client");
  ErrorRecoveryClient();
  const terminal = () => state[PHASE] === "done" || state[PHASE] === "fatal";
  for (let i = 0; i < 300 && !terminal(); i++) await new Promise((r) => realSetTimeout(r, 5));
  const of = (s: number) => calls.filter((c) => c.slot === s).map((c) => c.value);
  return {
    urls,
    phases: of(PHASE),
    resumes: of(LAST_RESUME),
    counts: of(COUNT),
    finalPhase: state[PHASE],
    phaseDuringBackoff,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("error-recovery claims a resume only after it connects (#158)", () => {
  it("a resume request that is refused shows fatal error without a resumed pill or a recovery", async () => {
    const r = await drive("reject");
    expect(r.urls).toEqual(["/api/error-recovery?checkpoint=0", "/api/error-recovery?checkpoint=2"]);
    expect(r.finalPhase).toBe("fatal");
    expect(r.resumes.filter((v) => v !== null)).toEqual([]);
    expect(r.counts).toEqual([]);
  });

  it("a resume request answered 503 shows fatal error without a resumed pill or a recovery", async () => {
    const r = await drive("503");
    expect(r.urls).toHaveLength(2);
    expect(r.finalPhase).toBe("fatal");
    expect(r.resumes.filter((v) => v !== null)).toEqual([]);
    expect(r.counts).toEqual([]);
  });

  it("a resume that connects still shows the pill at the drop position and counts one recovery (control)", async () => {
    const r = await drive("ok");
    expect(r.finalPhase).toBe("done");
    const shown = r.resumes.filter((v) => v !== null) as { at: number }[];
    expect(shown).toHaveLength(1);
    expect(shown[0].at).toBe(2);
    expect(r.counts).toEqual([1]);
    expect(state[0]).toBe("Hello world!");
  });

  it("the phase reads recovering, not streaming, during the back-off before the reconnect", async () => {
    const r = await drive("ok");
    expect(r.phaseDuringBackoff).toBe("recovering");
    // And once text flows again it is streaming, then done (#64 still holds).
    expect(r.phases.slice(-2)).toEqual(["streaming", "done"]);
  });
});
