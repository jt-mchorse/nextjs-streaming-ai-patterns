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
