import { describe, it, expect } from "vitest";

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

describe("mockTextStream", () => {
  it("yields chunks whose concatenation equals the fixture", async () => {
    const chunks = await collect(mockTextStream({ seed: 1 }));
    expect(chunks.join("")).toBe(MOCK_FIXTURE);
  });

  it("is deterministic given a seed", async () => {
    const a = await collect(mockTextStream({ seed: 42 }));
    const b = await collect(mockTextStream({ seed: 42 }));
    expect(a).toEqual(b);
  });

  it("yields more than one chunk (would be useless otherwise)", async () => {
    const chunks = await collect(mockTextStream({ seed: 1 }));
    expect(chunks.length).toBeGreaterThan(5);
  });

  it("does not introduce wall-clock delay when seeded", async () => {
    const start = Date.now();
    await collect(mockTextStream({ seed: 1 }));
    const elapsed = Date.now() - start;
    // Should be near-instantaneous (<200ms even on a slow machine).
    expect(elapsed).toBeLessThan(200);
  });
});

describe("mockTextStream — AbortSignal parity (issue #22)", () => {
  it("yields zero tokens when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const chunks = await collect(mockTextStream({ seed: 1, signal: ctrl.signal }));
    expect(chunks).toEqual([]);
  });

  it("stops yielding new tokens after the signal aborts mid-iteration", async () => {
    const ctrl = new AbortController();
    const gen = mockTextStream({ seed: 1, signal: ctrl.signal });
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
    const chunks = await collect(mockTextStream({ seed: 1 }));
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
    "accepts baseDelayMs=%p (with seed=1 so test stays fast)",
    async (good) => {
      const chunks = await collect(mockTextStream({ baseDelayMs: good, jitterMs: 0, seed: 1 }));
      expect(chunks.join("")).toBe(MOCK_FIXTURE);
    },
  );

  it.each([0, 1, 30, 30.5, 60_000])(
    "accepts jitterMs=%p (with seed=1 so test stays fast)",
    async (good) => {
      const chunks = await collect(mockTextStream({ baseDelayMs: 0, jitterMs: good, seed: 1 }));
      expect(chunks.join("")).toBe(MOCK_FIXTURE);
    },
  );

  it("validation runs before any yield (entry-site pin)", async () => {
    const gen = mockTextStream({ baseDelayMs: Number.NaN });
    await expect(gen.next()).rejects.toBeInstanceOf(RangeError);
  });
});
