import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_EVERY,
  CheckpointStreamDropped,
  TOTAL_TOKENS,
  resumeTokenPosition,
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

// Issue #24: validateOptions runs at the top of streamCheckpoints so the
// demo's mid-stream-drop and resume paths can't be silently misrepresented
// by operator misconfig. The most concrete harm: dropAfter = 0 fires the
// drop on the *first* text event because emittedThisRun = 1 >= 0 — the
// operator probably meant "no drop" but got "immediate drop".
describe("streamCheckpoints — StreamOptions validation (issue #24)", () => {
  async function expectThrows(options: ConstructorParameters<typeof Object>[0]): Promise<unknown> {
    return collect(streamCheckpoints(options as never)).then(
      () => null,
      (e: unknown) => e,
    );
  }

  it.each([
    { value: -1, label: "negative" },
    { value: 1.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
  ])("rejects startAfter $label ($value)", async ({ value }) => {
    const err = await expectThrows({ startAfter: value });
    expect(err).toBeInstanceOf(RangeError);
    expect(String(err)).toMatch(/startAfter must be an integer >= 0/);
  });

  it("accepts startAfter = 0 (start fresh; matches the documented default)", async () => {
    const events = await collect(streamCheckpoints({ startAfter: 0 }));
    // Same shape as the default (omitted) call: TOTAL_TOKENS text events.
    const texts = events.filter((e): e is TextEvent => e.kind === "text");
    expect(texts.length).toBe(TOTAL_TOKENS);
  });

  it.each([
    { value: 0, label: "zero (would silently fire drop on first token)" },
    { value: -1, label: "negative" },
    { value: 1.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "+Infinity" },
  ])("rejects dropAfter $label ($value)", async ({ value }) => {
    const err = await expectThrows({ dropAfter: value });
    expect(err).toBeInstanceOf(RangeError);
    expect(String(err)).toMatch(/dropAfter must be an integer >= 1/);
  });

  it("accepts dropAfter = 1 (minimum valid; drops after one text event)", async () => {
    let dropped = false;
    let textCount = 0;
    try {
      for await (const e of streamCheckpoints({ dropAfter: 1 })) {
        if (e.kind === "text") textCount += 1;
      }
    } catch (err) {
      expect(err).toBeInstanceOf(CheckpointStreamDropped);
      dropped = true;
    }
    expect(dropped).toBe(true);
    expect(textCount).toBe(1);
  });

  it("validation runs before any yield (entry-site pin)", async () => {
    // If validation drifted inside the for-loop, the generator would yield
    // the first text event before throwing. The expect-throws-immediately
    // contract is what makes the demo route handler's error path predictable.
    const gen = streamCheckpoints({ dropAfter: 0 });
    await expect(gen.next()).rejects.toBeInstanceOf(RangeError);
  });
});

// Issue #58: the client must resume from the server-reported drop position
// (`last_token` on the error event), not the last recorded checkpoint. The drop
// is independent of CHECKPOINT_EVERY and lands past the last checkpoint, so
// resuming from the checkpoint replays — and the client re-renders (duplicates)
// — the tokens between the checkpoint and the drop.
describe("resumeTokenPosition (issue #58)", () => {
  it("advances to the drop position when it is past the last checkpoint", () => {
    // The exact demo shape: checkpoints at 5/10, drop at 12.
    expect(resumeTokenPosition(10, 12)).toBe(12);
  });

  it("falls back to the checkpoint when no drop position is given", () => {
    // The network-drop path (no `error` frame) carries no last_token.
    expect(resumeTokenPosition(10, undefined)).toBe(10);
  });

  it("ignores a drop position behind the checkpoint (never rewinds)", () => {
    // A stale/lower last_token must not rewind and re-stream already-shown text.
    expect(resumeTokenPosition(10, 7)).toBe(10);
  });

  it("ignores a non-integer drop position", () => {
    expect(resumeTokenPosition(10, Number.NaN)).toBe(10);
    expect(resumeTokenPosition(10, 11.5)).toBe(10);
  });

  it("equal checkpoint and drop position resume from that position", () => {
    expect(resumeTokenPosition(10, 10)).toBe(10);
  });
});
