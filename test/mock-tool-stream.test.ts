import { describe, expect, it } from "vitest";
import { mockToolStream, type ToolStreamEvent } from "../lib/mock-tool-stream";

async function collect(stream: AsyncGenerator<ToolStreamEvent>): Promise<ToolStreamEvent[]> {
  const out: ToolStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("mockToolStream — happy path", () => {
  it("emits the canonical event sequence", async () => {
    const events = await collect(mockToolStream({ baseDelayMs: 0, jitterMs: 0, seed: 1 }));
    const types = events.map((e) => e.type);
    // The order is locked: text → tool_use → tool_result → text → stop.
    expect(types).toContain("text_delta");
    expect(types).toContain("tool_use_start");
    expect(types).toContain("tool_use_delta");
    expect(types).toContain("tool_use_stop");
    expect(types).toContain("tool_result");
    expect(types).toContain("message_stop");
    // First tool_use_start precedes any tool_use_delta.
    const startIdx = types.indexOf("tool_use_start");
    const firstDelta = types.indexOf("tool_use_delta");
    expect(startIdx).toBeLessThan(firstDelta);
    // tool_use_stop precedes tool_result.
    const stopIdx = types.indexOf("tool_use_stop");
    const resultIdx = types.indexOf("tool_result");
    expect(stopIdx).toBeLessThan(resultIdx);
    // tool_result precedes the second batch of text_delta events.
    const allTextDeltas = types
      .map((t, i) => (t === "text_delta" ? i : -1))
      .filter((i) => i !== -1);
    expect(allTextDeltas[allTextDeltas.length - 1]).toBeGreaterThan(resultIdx);
    // Final event is message_stop with end_turn.
    const last = events[events.length - 1];
    expect(last?.type).toBe("message_stop");
    if (last?.type === "message_stop") {
      expect(last.stop_reason).toBe("end_turn");
    }
  });

  it("streaming JSON args concatenate to valid JSON", async () => {
    const events = await collect(mockToolStream({ baseDelayMs: 0, jitterMs: 0, seed: 1 }));
    const deltas = events.filter((e): e is Extract<ToolStreamEvent, { type: "tool_use_delta" }> => e.type === "tool_use_delta");
    const joined = deltas.map((d) => d.partial_json).join("");
    const parsed = JSON.parse(joined) as { city: string };
    expect(parsed.city).toBe("Austin");
  });

  it("tool_use_start carries name + id consumed by tool_result", async () => {
    const events = await collect(mockToolStream({ baseDelayMs: 0, jitterMs: 0, seed: 1 }));
    const start = events.find((e): e is Extract<ToolStreamEvent, { type: "tool_use_start" }> => e.type === "tool_use_start");
    const result = events.find((e): e is Extract<ToolStreamEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(start?.tool_use_id).toBe(result?.tool_use_id);
    expect(start?.tool_name).toBe("get_weather");
  });

  it("is deterministic given the same seed", async () => {
    const a = await collect(mockToolStream({ baseDelayMs: 0, jitterMs: 0, seed: 42 }));
    const b = await collect(mockToolStream({ baseDelayMs: 0, jitterMs: 0, seed: 42 }));
    expect(a.map((e) => JSON.stringify(e))).toEqual(b.map((e) => JSON.stringify(e)));
  });
});

describe("mockToolStream — interrupt path", () => {
  it("an early abort produces a partial transcript ending in message_stop(interrupted)", async () => {
    const ctrl = new AbortController();
    // Abort almost immediately — the stream should yield at most a
    // handful of events plus the interrupted terminator.
    ctrl.abort();
    const events = await collect(
      mockToolStream({ baseDelayMs: 0, jitterMs: 0, seed: 1, signal: ctrl.signal }),
    );
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last?.type).toBe("message_stop");
    if (last?.type === "message_stop") {
      expect(last.stop_reason).toBe("interrupted");
    }
  });

  it("an abort mid-stream still produces a clean terminator", async () => {
    const ctrl = new AbortController();
    const events: ToolStreamEvent[] = [];
    let aborted = false;
    for await (const e of mockToolStream({ baseDelayMs: 0, jitterMs: 0, seed: 1, signal: ctrl.signal })) {
      events.push(e);
      // Trigger the abort the first time we see a tool_use_delta.
      if (!aborted && e.type === "tool_use_delta") {
        aborted = true;
        ctrl.abort();
      }
    }
    const last = events[events.length - 1];
    expect(last?.type).toBe("message_stop");
    if (last?.type === "message_stop") {
      expect(last.stop_reason).toBe("interrupted");
    }
    // We never reached the tool_result or post-tool text because we
    // aborted before then.
    const types = events.map((e) => e.type);
    expect(types).not.toContain("tool_result");
  });
});

// Issue #26: validateOptions runs at entry of mockToolStream. Sibling to
// the checkpoint-stream #24 pattern.
describe("mockToolStream — MockToolStreamOptions validation (issue #26)", () => {
  async function expectThrows(options: unknown): Promise<unknown> {
    return collect(mockToolStream(options as never)).then(
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
      /MockToolStreamOptions\.baseDelayMs must be a finite non-negative number/,
    );
  });

  it.each(BAD_VALUES)("rejects jitterMs $label", async ({ value }) => {
    const err = await expectThrows({ jitterMs: value });
    expect(err).toBeInstanceOf(RangeError);
    expect(String(err)).toMatch(
      /MockToolStreamOptions\.jitterMs must be a finite non-negative number/,
    );
  });

  // Acceptance: small values run to completion with baseDelay=0 so the
  // suite stays fast. Large values are pinned via construction-only checks
  // since `mockToolStream` sleeps unconditionally (no `seed-skips-sleep`
  // path like `mockTextStream`).
  it.each([0, 1, 30, 30.5])(
    "accepts baseDelayMs=%p",
    async (good) => {
      const gen = mockToolStream({ baseDelayMs: good, jitterMs: 0, seed: 1 });
      await expect(gen.next()).resolves.toBeDefined();
      await gen.return();
    },
  );

  it.each([0, 1, 30, 30.5])(
    "accepts jitterMs=%p",
    async (good) => {
      const gen = mockToolStream({ baseDelayMs: 0, jitterMs: good, seed: 1 });
      await expect(gen.next()).resolves.toBeDefined();
      await gen.return();
    },
  );

  it("accepts large baseDelayMs without rejecting (validator-only check)", () => {
    // Construct only — don't iterate, since `mockToolStream` sleeps each
    // yield (no test-mode bypass on this surface) and we don't want a 60s
    // wait in the suite.
    expect(() => mockToolStream({ baseDelayMs: 60_000, jitterMs: 0, seed: 1 })).not.toThrow();
  });

  it("validation runs before any yield (entry-site pin)", async () => {
    const gen = mockToolStream({ baseDelayMs: Number.NaN });
    await expect(gen.next()).rejects.toBeInstanceOf(RangeError);
  });
});

describe("mockToolStream — abort race windows (#40)", () => {
  it("does not inject a tool_result when aborted during the pre-result sleep", async () => {
    // Pump to just after `tool_use_stop` (generator suspended before the sleep
    // that precedes `tool_result`), then abort. The next resume enters that
    // sleep with an already-aborted signal; the stream must report interrupted
    // and must NOT emit a fabricated tool_result for a cancelled tool call.
    const controller = new AbortController();
    const gen = mockToolStream({
      baseDelayMs: 0,
      jitterMs: 0,
      seed: 1,
      signal: controller.signal,
    });
    const seen: ToolStreamEvent[] = [];
    let value: ToolStreamEvent | undefined;
    do {
      const next = await gen.next();
      if (next.done || !next.value) throw new Error("stream ended before tool_use_stop");
      value = next.value;
      seen.push(value);
    } while (value.type !== "tool_use_stop");

    controller.abort();
    const after = await gen.next();
    expect(after.value).toEqual({ type: "message_stop", stop_reason: "interrupted" });
    expect(seen.some((e) => e.type === "tool_result")).toBe(false);
  });

  it("reports interrupted (not end_turn) when aborted during the final sleep", async () => {
    // Count events on a clean run so we can stop exactly at the post-last-text
    // final-sleep window on the aborted run.
    const clean = await collect(mockToolStream({ baseDelayMs: 0, jitterMs: 0, seed: 1 }));
    const total = clean.length; // includes the terminal message_stop
    const controller = new AbortController();
    const gen = mockToolStream({
      baseDelayMs: 0,
      jitterMs: 0,
      seed: 1,
      signal: controller.signal,
    });
    // Pump every event except the terminal message_stop; the generator is then
    // suspended just before the Phase-6 final sleep.
    for (let n = 0; n < total - 1; n++) {
      const next = await gen.next();
      if (next.done) throw new Error("stream ended early");
    }
    controller.abort();
    const after = await gen.next();
    expect(after.value).toEqual({ type: "message_stop", stop_reason: "interrupted" });
  });
});
