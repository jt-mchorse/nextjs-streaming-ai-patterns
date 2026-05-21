import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { TIMELINE, type DemoStop } from "../scripts/capture_demo";

/**
 * Smoke test for `scripts/capture_demo.ts` (issue #12).
 *
 * The actual binary recording happens out-of-band (Playwright
 * browsers + dev server + ffmpeg) and is tracked in #13. This test
 * does not launch a browser — it validates the *script* the binary
 * is recorded from, so any drift between the capture's tour and
 * `app/page.tsx`'s `PATTERNS` array fires here instead of producing
 * a video that links to a 404'd pattern.
 *
 * Drift this catches:
 *   - a pattern slug is renamed in app/page.tsx without updating
 *     the TIMELINE
 *   - a pattern's `app/<slug>/page.tsx` is deleted or moved
 *   - the TIMELINE's total duration drifts far enough that the
 *     recording no longer fits the 60-second budget
 *   - the homepage stop is dropped or moved out of first position
 *
 * Mirrors the same drift-prevention shape as
 * `test/readme-patterns-table.test.ts` (parse → assert structure
 * against the canonical PATTERNS array).
 */

const ROOT = resolve(__dirname, "..");
const HOMEPAGE_PATH = resolve(ROOT, "app/page.tsx");

function parseHomepageSlugs(): string[] {
  const src = readFileSync(HOMEPAGE_PATH, "utf8");
  // Match the same slug pattern used by readme-patterns-table.test.ts.
  const slugs = Array.from(src.matchAll(/slug:\s*"([^"]+)"/g)).map(
    (m) => m[1],
  );
  if (slugs.length === 0) {
    throw new Error(
      `parseHomepageSlugs found 0 slugs in ${HOMEPAGE_PATH} — regex out of sync with PATTERNS shape?`,
    );
  }
  return slugs;
}

describe("scripts/capture_demo.ts TIMELINE", () => {
  const homepageSlugs = parseHomepageSlugs();

  it("starts on the homepage", () => {
    expect(TIMELINE[0]?.slug).toBe("/");
  });

  it("visits every PATTERNS slug from app/page.tsx exactly once", () => {
    const tourSlugs = TIMELINE.map((s) => s.slug).filter((s) => s !== "/");
    expect(tourSlugs).toEqual(homepageSlugs);
  });

  it("has no duplicate stops", () => {
    const slugs = TIMELINE.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("references only routes that exist on disk", () => {
    for (const stop of TIMELINE) {
      if (stop.slug === "/") {
        expect(existsSync(HOMEPAGE_PATH)).toBe(true);
        continue;
      }
      const pagePath = resolve(ROOT, `app${stop.slug}/page.tsx`);
      expect(
        existsSync(pagePath),
        `expected ${pagePath} to exist for capture stop "${stop.label}"`,
      ).toBe(true);
    }
  });

  it("each stop has a non-empty label and a non-negative holdMs", () => {
    for (const stop of TIMELINE) {
      expect(stop.label.length, `empty label on ${stop.slug}`).toBeGreaterThan(0);
      expect(stop.holdMs).toBeGreaterThanOrEqual(0);
      expect(stop.durationMs).toBeGreaterThanOrEqual(stop.holdMs);
    }
  });

  it("total duration is in the 30s–90s recording window", () => {
    // 60s is the headline number from the issue; the smoke test
    // accepts 30s..90s so adding/dropping a stop doesn't immediately
    // break the test — it forces a deliberate retune. If you find
    // yourself widening this range, file a sibling issue first.
    const totalMs = TIMELINE.reduce(
      (acc: number, s: DemoStop) => acc + s.durationMs,
      0,
    );
    expect(totalMs).toBeGreaterThanOrEqual(30_000);
    expect(totalMs).toBeLessThanOrEqual(90_000);
  });
});
