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
