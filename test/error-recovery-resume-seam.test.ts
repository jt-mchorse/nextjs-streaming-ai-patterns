/**
 * Error-recovery resume-seam lock (issue #80).
 *
 * On a RAW network drop (no SSE `error` frame) the client must resume from the
 * furthest token it actually rendered, not the last checkpoint — otherwise it
 * replays and re-appends the up-to-`CHECKPOINT_EVERY-1` tokens shown since the
 * last checkpoint, duplicating text at the drop seam. #58 fixed this for the
 * error-frame branch; the raw-drop branches route through `scheduleResume`.
 *
 * Like `test/streaming-client-cleanup.test.ts`, this repo has no
 * component-render harness (no jsdom / testing-library), so the wiring is
 * locked against the committed source: the client must record each text
 * event's `index` and resume from `Math.max(...)` over that rendered index.
 * The behavioral proof (a raw-drop resume reproduces the clean stream) lives in
 * `test/checkpoint-stream.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLIENT = resolve(__dirname, "..", "components", "error-recovery-client.tsx");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("error-recovery resume-seam (#80)", () => {
  const src = stripComments(readFileSync(CLIENT, "utf-8"));

  it("records the furthest rendered text-token index", () => {
    // The text handler must capture `ev.index` (which it otherwise discards)
    // into a ref so the raw-drop resume has client-side truth to resume from.
    expect(
      /\.current\s*=\s*ev\.index/.test(src),
      "error-recovery-client.tsx must record each text event's `index` (e.g. " +
        "`lastRendered.current = ev.index`) so a raw drop can resume from the " +
        "furthest rendered token instead of the stale checkpoint (see #80).",
    ).toBe(true);
  });

  it("resumes from the max of checkpoint and rendered index, not the bare checkpoint", () => {
    // The resume anchor must be Math.max(lastCheckpoint, lastRendered); resuming
    // from `lastCheckpoint.current` alone re-streams already-rendered tokens.
    expect(
      /Math\.max\(\s*lastCheckpoint\.current\s*,\s*lastRendered\.current\s*\)/.test(src),
      "scheduleResume() must resume from `Math.max(lastCheckpoint.current, " +
        "lastRendered.current)` so the raw-drop branches don't duplicate text " +
        "at the seam (see #58 for the error-frame sibling).",
    ).toBe(true);
  });
});
