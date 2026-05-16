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
