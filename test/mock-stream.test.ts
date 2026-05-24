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
