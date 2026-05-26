import { describe, expect, it } from "vitest";
import { _MOCK_JSON_FULL_RESPONSE, mockJsonStream } from "../lib/mock-json-stream";
import { parsePartialJson } from "../lib/partial-json";

describe("mockJsonStream", () => {
  it("emits json_delta chunks that reconstruct the full payload, then a message_stop", async () => {
    const events: { type: string; delta?: string; stop_reason?: string }[] = [];
    for await (const e of mockJsonStream({ baseDelayMs: 0, jitterMs: 0, seed: 1 })) {
      events.push(e);
    }
    const deltas = events.filter((e) => e.type === "json_delta").map((e) => e.delta);
    const stops = events.filter((e) => e.type === "message_stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.stop_reason).toBe("end_turn");
    const joined = deltas.join("");
    expect(JSON.parse(joined)).toEqual(_MOCK_JSON_FULL_RESPONSE);
  });

  it("respects an AbortSignal and emits stop_reason=interrupted", async () => {
    const controller = new AbortController();
    const events: { type: string; stop_reason?: string }[] = [];
    let chunkCount = 0;
    for await (const e of mockJsonStream({
      baseDelayMs: 0,
      jitterMs: 0,
      seed: 1,
      signal: controller.signal,
    })) {
      events.push(e);
      if (e.type === "json_delta") {
        chunkCount += 1;
        if (chunkCount === 2) controller.abort();
      }
    }
    const stops = events.filter((e) => e.type === "message_stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.stop_reason).toBe("interrupted");
    expect(chunkCount).toBeLessThan(20); // bounded — should not have drained the full stream
  });

  it("produces a sequence where parsePartialJson reaches the full payload by the end", async () => {
    let buffer = "";
    let finalParse: unknown = null;
    for await (const e of mockJsonStream({ baseDelayMs: 0, jitterMs: 0, seed: 1 })) {
      if (e.type === "json_delta") {
        buffer += e.delta;
        const r = parsePartialJson(buffer);
        if (r.isComplete) finalParse = r.value;
      }
    }
    expect(finalParse).toEqual(_MOCK_JSON_FULL_RESPONSE);
  });
});

// Issue #26: validateOptions runs at entry of mockJsonStream. Sibling to
// the checkpoint-stream #24 pattern.
describe("mockJsonStream — MockJsonStreamOptions validation (issue #26)", () => {
  async function collectJson(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const e of stream) out.push(e);
    return out;
  }

  async function expectThrows(options: unknown): Promise<unknown> {
    return collectJson(mockJsonStream(options as never)).then(
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
      /MockJsonStreamOptions\.baseDelayMs must be a finite non-negative number/,
    );
  });

  it.each(BAD_VALUES)("rejects jitterMs $label", async ({ value }) => {
    const err = await expectThrows({ jitterMs: value });
    expect(err).toBeInstanceOf(RangeError);
    expect(String(err)).toMatch(
      /MockJsonStreamOptions\.jitterMs must be a finite non-negative number/,
    );
  });

  // Acceptance: small values run a single .next() with baseDelay=0 so the
  // suite stays fast. Large values are pinned via construction-only checks
  // since `mockJsonStream` sleeps unconditionally (no `seed-skips-sleep`
  // path on this surface).
  it.each([0, 1, 80, 80.5])(
    "accepts baseDelayMs=%p",
    async (good) => {
      const gen = mockJsonStream({ baseDelayMs: good, jitterMs: 0, seed: 1 });
      await expect(gen.next()).resolves.toBeDefined();
      await gen.return();
    },
  );

  it.each([0, 1, 40, 40.5])(
    "accepts jitterMs=%p",
    async (good) => {
      const gen = mockJsonStream({ baseDelayMs: 0, jitterMs: good, seed: 1 });
      await expect(gen.next()).resolves.toBeDefined();
      await gen.return();
    },
  );

  it("accepts large baseDelayMs without rejecting (validator-only check)", () => {
    expect(() => mockJsonStream({ baseDelayMs: 60_000, jitterMs: 0, seed: 1 })).not.toThrow();
  });

  it("validation runs before any yield (entry-site pin)", async () => {
    const gen = mockJsonStream({ baseDelayMs: Number.NaN });
    await expect(gen.next()).rejects.toBeInstanceOf(RangeError);
  });
});
