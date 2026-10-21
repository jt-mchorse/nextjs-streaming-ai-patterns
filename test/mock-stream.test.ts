import { afterEach, describe, it, expect, vi } from "vitest";

import { mockTextStream, chunkByWhitespace, MOCK_FIXTURE } from "@/lib/mock-stream";

async function collect(gen: AsyncGenerator<{ text: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of gen) out.push(chunk.text);
  return out;
}

describe("chunkByWhitespace", () => {
  it("attaches trailing whitespace to its preceding token", () => {
    expect(chunkByWhitespace("a b  c")).toEqual(["a ", "b ", " ", "c"]);
  });

  it("returns a single chunk for a string with no whitespace", () => {
    expect(chunkByWhitespace("hello")).toEqual(["hello"]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkByWhitespace("")).toEqual([]);
  });
});

// Zero delay. Since #206 `seed` alone no longer makes the stream instant, so
// tests that want speed say so the way the sibling streamers' tests do.
const FAST = { baseDelayMs: 0, jitterMs: 0, seed: 1 } as const;

describe("mockTextStream", () => {
  it("yields chunks whose concatenation equals the fixture", async () => {
    const chunks = await collect(mockTextStream(FAST));
    expect(chunks.join("")).toBe(MOCK_FIXTURE);
  });

  it("is deterministic given a seed", async () => {
    const a = await collect(mockTextStream({ ...FAST, seed: 42 }));
    const b = await collect(mockTextStream({ ...FAST, seed: 42 }));
    expect(a).toEqual(b);
  });

  it("yields more than one chunk (would be useless otherwise)", async () => {
    const chunks = await collect(mockTextStream(FAST));
    expect(chunks.length).toBeGreaterThan(5);
  });

  it("does not introduce wall-clock delay with a zero delay (#206: not with seed alone)", async () => {
    const start = Date.now();
    await collect(mockTextStream(FAST));
    const elapsed = Date.now() - start;
    // Should be near-instantaneous (<200ms even on a slow machine).
    expect(elapsed).toBeLessThan(200);
  });
});

describe("mockTextStream — AbortSignal parity (issue #22)", () => {
  it("yields zero tokens when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const chunks = await collect(mockTextStream({ ...FAST, signal: ctrl.signal }));
    expect(chunks).toEqual([]);
  });

  it("stops yielding new tokens after the signal aborts mid-iteration", async () => {
    const ctrl = new AbortController();
    const gen = mockTextStream({ ...FAST, signal: ctrl.signal });
    const out: string[] = [];
    const { value: first } = await gen.next();
    if (first) out.push(first.text);
    ctrl.abort();
    for await (const chunk of gen) {
      out.push(chunk.text);
    }
    // Generator returned after the abort. The exact number depends on
    // whether the loop body re-checked the signal before the next yield
    // or after — both are correct semantics; the contract is "no more
    // than one extra token after abort, then stop".
    expect(out.length).toBeLessThan(5);
    // First yielded token came before the abort and is present.
    expect(out.length).toBeGreaterThanOrEqual(1);
  });

  it("without a signal, still emits every fixture token (regression-pin)", async () => {
    const chunks = await collect(mockTextStream(FAST));
    expect(chunks.join("")).toBe(MOCK_FIXTURE);
  });
});

// Issue #26: validateOptions runs at entry of mockTextStream. Sibling to
// the checkpoint-stream #24 pattern but on the bounded-non-negative-
// finite-ms domain.
describe("mockTextStream — MockStreamOptions validation (issue #26)", () => {
  async function expectThrows(options: unknown): Promise<unknown> {
    return collect(mockTextStream(options as never)).then(
      () => null,
      (e: unknown) => e,
    );
  }

  // Validation runs when the first `next()` starts the body, so a first step
  // that reaches the first sleep (and is then aborted out of it) is the
  // acceptance check. Since #206 a seed no longer skips the delay, so the
  // old "collect the whole fixture with seed=1" shape would wait out every
  // token at up to 60 s each.
  async function expectAccepted(options: object): Promise<void> {
    const ctrl = new AbortController();
    const pending = mockTextStream({ ...options, signal: ctrl.signal }).next();
    ctrl.abort();
    // Accepted == the first step resolves (a token or an aborted `done`).
    await expect(pending).resolves.toBeDefined();
  }

  const BAD_VALUES = [
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
    { value: Number.NEGATIVE_INFINITY, label: "-Infinity" },
    { value: -1, label: "negative" },
    { value: true, label: "true" },
    { value: false, label: "false" },
    { value: "30", label: "numeric string" },
    { value: null, label: "null" },
  ];

  it.each(BAD_VALUES)("rejects baseDelayMs $label", async ({ value }) => {
    const err = await expectThrows({ baseDelayMs: value });
    expect(err).toBeInstanceOf(RangeError);
    expect(String(err)).toMatch(
      /MockStreamOptions\.baseDelayMs must be a finite non-negative number/,
    );
  });

  it.each(BAD_VALUES)("rejects jitterMs $label", async ({ value }) => {
    const err = await expectThrows({ jitterMs: value });
    expect(err).toBeInstanceOf(RangeError);
    expect(String(err)).toMatch(
      /MockStreamOptions\.jitterMs must be a finite non-negative number/,
    );
  });

  it.each([0, 1, 30, 30.5, 60_000])(
    "accepts baseDelayMs=%p",
    async (good) => {
      await expectAccepted({ baseDelayMs: good, jitterMs: 0, seed: 1 });
    },
  );

  it.each([0, 1, 30, 30.5, 60_000])(
    "accepts jitterMs=%p",
    async (good) => {
      await expectAccepted({ baseDelayMs: 0, jitterMs: good, seed: 1 });
    },
  );

  it("validation runs before any yield (entry-site pin)", async () => {
    const gen = mockTextStream({ baseDelayMs: Number.NaN });
    await expect(gen.next()).rejects.toBeInstanceOf(RangeError);
  });
});

// Issue #206: `seed` used to skip the inter-token delay entirely ("seed
// implies test"), so it seeded no jitter and `baseDelayMs`/`jitterMs` were
// validated and then ignored. `mockJsonStream`/`mockToolStream` honour the
// delay with a seed set; this pins the text streamer to the same rule.
describe("mockTextStream — seed seeds the jitter, it does not skip the delay (#206)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The delays the stream hands to `setTimeout`, for the first `n` tokens.
  async function delaySchedule(options: object, n: number): Promise<number[]> {
    // Record the requested delay, then fire on the next tick so the test
    // doesn't wait out up to a second per token.
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(Number(ms));
      return realSetTimeout(fn, 0);
    }) as unknown as typeof setTimeout);
    const gen = mockTextStream({ baseDelayMs: 0, ...options });
    for (let i = 0; i < n; i++) await gen.next();
    await gen.return(undefined);
    vi.restoreAllMocks();
    return delays;
  }

  async function firstEventMs(options: object): Promise<number> {
    const start = performance.now();
    const gen = mockTextStream(options);
    await gen.next();
    await gen.return(undefined);
    return performance.now() - start;
  }

  it("a seeded stream waits baseDelayMs before the first token", async () => {
    expect(await firstEventMs({ baseDelayMs: 120, jitterMs: 0, seed: 1 })).toBeGreaterThanOrEqual(100);
  });

  it("control: an unseeded stream waits baseDelayMs before the first token", async () => {
    expect(await firstEventMs({ baseDelayMs: 120, jitterMs: 0 })).toBeGreaterThanOrEqual(100);
  });

  it("control: a seeded zero-delay stream yields its first token immediately", async () => {
    expect(await firstEventMs({ baseDelayMs: 0, jitterMs: 0, seed: 1 })).toBeLessThan(100);
  });

  it("a seeded stream schedules one delay per token, each base + jitter", async () => {
    const delays = await delaySchedule({ baseDelayMs: 5, jitterMs: 1000, seed: 1 }, 8);
    expect(delays).toHaveLength(8);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(5);
      expect(d).toBeLessThan(1005);
    }
  });

  it("the same seed reproduces the delay schedule; a different seed changes it", async () => {
    const opts = { jitterMs: 1000 };
    const a = await delaySchedule({ ...opts, seed: 1 }, 8);
    const b = await delaySchedule({ ...opts, seed: 1 }, 8);
    const c = await delaySchedule({ ...opts, seed: 999 }, 8);
    expect(a).toHaveLength(8);
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
  });
});
