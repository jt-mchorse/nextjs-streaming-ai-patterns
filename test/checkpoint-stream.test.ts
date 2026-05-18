import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_EVERY,
  CheckpointStreamDropped,
  TOTAL_TOKENS,
  streamCheckpoints,
  type CheckpointEvent,
  type StreamEvent,
  type TextEvent,
} from "../lib/checkpoint-stream";

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}

describe("streamCheckpoints — clean run", () => {
  it("emits exactly TOTAL_TOKENS text events when streamed to completion", async () => {
    const events = await collect(streamCheckpoints());
    const text = events.filter((e): e is TextEvent => e.kind === "text");
    expect(text.length).toBe(TOTAL_TOKENS);
  });

  it("emits a checkpoint every CHECKPOINT_EVERY text tokens", async () => {
    const events = await collect(streamCheckpoints());
    const checkpoints = events.filter(
      (e): e is CheckpointEvent => e.kind === "checkpoint",
    );
    // Each checkpoint's last_token is a positive multiple of CHECKPOINT_EVERY.
    for (const cp of checkpoints) {
      expect(cp.last_token % CHECKPOINT_EVERY).toBe(0);
      expect(cp.last_token).toBeGreaterThan(0);
    }
    // The last checkpoint's last_token <= TOTAL_TOKENS.
    if (checkpoints.length > 0) {
      const last = checkpoints[checkpoints.length - 1];
      expect(last.last_token).toBeLessThanOrEqual(TOTAL_TOKENS);
    }
    // And we got the expected count of checkpoints.
    expect(checkpoints.length).toBe(Math.floor(TOTAL_TOKENS / CHECKPOINT_EVERY));
  });

  it("text events carry 1-indexed strictly-increasing index", async () => {
    const events = await collect(streamCheckpoints());
    const text = events.filter((e): e is TextEvent => e.kind === "text");
    text.forEach((e, i) => {
      expect(e.index).toBe(i + 1);
    });
  });

  it("reassembling text yields the full fixture (modulo skipped tokens)", async () => {
    const events = await collect(streamCheckpoints());
    const reassembled = events
      .filter((e): e is TextEvent => e.kind === "text")
      .map((e) => e.text)
      .join("");
    expect(reassembled.length).toBeGreaterThan(0);
    expect(reassembled).toContain("mid-stream error");
    expect(reassembled).toContain("checkpoint");
  });
});

describe("streamCheckpoints — drop simulation", () => {
  it("throws CheckpointStreamDropped after emitting dropAfter text tokens", async () => {
    let emittedBeforeDrop = 0;
    try {
      for await (const e of streamCheckpoints({ dropAfter: 7 })) {
        if (e.kind === "text") emittedBeforeDrop += 1;
      }
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CheckpointStreamDropped);
      const dropped = err as CheckpointStreamDropped;
      // emitted carries the *index* of the last emitted text token,
      // which after 7 text emissions equals 7.
      expect(dropped.emitted).toBe(7);
      expect(emittedBeforeDrop).toBe(7);
    }
  });

  it("emits at least one checkpoint before the drop when dropAfter > CHECKPOINT_EVERY", async () => {
    const events: StreamEvent[] = [];
    try {
      for await (const e of streamCheckpoints({ dropAfter: 7 })) {
        events.push(e);
      }
    } catch {
      // expected
    }
    const checkpoints = events.filter(
      (e): e is CheckpointEvent => e.kind === "checkpoint",
    );
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
  });
});

describe("streamCheckpoints — resume", () => {
  it("startAfter skips the first N text tokens and resumes index numbering at N+1", async () => {
    const startAfter = 5;
    const events = await collect(streamCheckpoints({ startAfter }));
    const text = events.filter((e): e is TextEvent => e.kind === "text");
    expect(text.length).toBe(TOTAL_TOKENS - startAfter);
    expect(text[0].index).toBe(startAfter + 1);
    expect(text[text.length - 1].index).toBe(TOTAL_TOKENS);
  });

  it("startAfter + dropAfter compose — resume mode that also drops", async () => {
    const startAfter = 5;
    const dropAfter = 3;
    const textIndices: number[] = [];
    try {
      for await (const e of streamCheckpoints({ startAfter, dropAfter })) {
        if (e.kind === "text") textIndices.push(e.index);
      }
    } catch (err) {
      expect(err).toBeInstanceOf(CheckpointStreamDropped);
    }
    expect(textIndices.length).toBe(dropAfter);
    expect(textIndices[0]).toBe(startAfter + 1);
  });

  it("startAfter beyond TOTAL_TOKENS yields no text events and no checkpoints", async () => {
    const events = await collect(streamCheckpoints({ startAfter: 9999 }));
    expect(events.length).toBe(0);
  });
});
