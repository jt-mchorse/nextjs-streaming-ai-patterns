/**
 * The error-recovery "resumed at token N" pill goes away (#152).
 *
 * Visibility was decided only during render, `Date.now() - when < 2_500`, and
 * nothing re-rendered when that window closed. The resumed mock stream ends in
 * under a second, so the pill stayed for good: on a mock-mode `next dev`,
 * Playwright saw it at 500 ms, 2.5 s, 6 s and 10 s after load. After the fix,
 * the same probe saw it at 500 ms and 1.5 s and not at 2.5 s or later.
 *
 * The window arithmetic is tested directly. The component has no DOM test
 * environment in this repo, so its half is a source lock in the style of
 * `capture-demo-interactions.test.ts`: it must read visibility through the
 * helper AND schedule the clear, because a render-time check alone is exactly
 * the bug.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RESUMED_PILL_MS,
  isResumedPillVisible,
  resumedPillRemainingMs,
} from "@/lib/resume-pill";

describe("resumedPillRemainingMs", () => {
  it.each([
    [0, RESUMED_PILL_MS],
    [1, RESUMED_PILL_MS - 1],
    [RESUMED_PILL_MS - 1, 1],
    [RESUMED_PILL_MS, 0],
    [RESUMED_PILL_MS + 1, 0],
    [60_000, 0],
  ])("at +%i ms leaves %i ms", (elapsed, remaining) => {
    expect(resumedPillRemainingMs(1_000, 1_000 + elapsed)).toBe(remaining);
  });

  it("a clock that moved backwards gets the full window, not a longer one", () => {
    expect(resumedPillRemainingMs(5_000, 4_000)).toBe(RESUMED_PILL_MS);
  });

  it.each([NaN, Infinity, -Infinity])("a non-finite now (%s) reads as closed", (now) => {
    expect(resumedPillRemainingMs(1_000, now)).toBe(0);
  });

  it("visibility is exactly 'time remains'", () => {
    expect(isResumedPillVisible(0, RESUMED_PILL_MS - 1)).toBe(true);
    expect(isResumedPillVisible(0, RESUMED_PILL_MS)).toBe(false);
  });
});

describe("error-recovery-client schedules the pill's clear (#152)", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "components", "error-recovery-client.tsx"),
    "utf8",
  );

  it("reads visibility through the shared helper, not a second copy of the window", () => {
    expect(src).toMatch(/isResumedPillVisible\(\s*lastResume\.when/);
    expect(src).not.toMatch(/2_500|2500/);
  });

  it("an effect keyed on lastResume sets a timer from the remaining time and clears it", () => {
    const effect = src.match(/useEffect\(\(\) => \{\s*if \(lastResume === null\) return;[\s\S]*?\}, \[lastResume\]\);/);
    expect(effect, "no effect keyed on [lastResume]").not.toBeNull();
    const body = effect![0];
    expect(body).toMatch(/setTimeout\(/);
    expect(body).toMatch(/resumedPillRemainingMs\(/);
    expect(body).toMatch(/setLastResume\(/);
    expect(body).toMatch(/return \(\) => clearTimeout\(/);
  });

  it("the clear only removes the pill it was scheduled for", () => {
    // A newer resume inside the window must keep its own full window.
    expect(src).toMatch(/current === shown \? null : current/);
  });
});
