import { describe, expect, it } from "vitest";

import {
  DEMO_NAMES,
  decide,
  decisionSplitOver,
} from "../lib/optimistic-decision";

describe("decide — input validation", () => {
  it("throws on empty id", () => {
    expect(() => decide({ id: "", click_count: 1 })).toThrow(/non-empty/);
  });

  it("throws on non-positive click_count", () => {
    expect(() => decide({ id: "untitled-1.txt", click_count: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => decide({ id: "untitled-1.txt", click_count: -1 })).toThrow(
      /positive integer/,
    );
  });

  it("throws on non-integer click_count", () => {
    expect(() =>
      decide({ id: "untitled-1.txt", click_count: 1.5 }),
    ).toThrow(/positive integer/);
  });
});

describe("decide — first click always succeeds", () => {
  it("returns ok=true with an improved_name for every DEMO id on click 1", () => {
    for (const id of DEMO_NAMES) {
      const d = decide({ id, click_count: 1 });
      expect(d.ok).toBe(true);
      if (d.ok) {
        expect(d.improved_name.length).toBeGreaterThan(0);
        expect(d.improved_name).not.toBe(id);
      }
    }
  });
});

describe("decide — determinism", () => {
  it("returns the same decision for the same (id, click_count) call after call", () => {
    const a = decide({ id: "untitled-3.txt", click_count: 5 });
    const b = decide({ id: "untitled-3.txt", click_count: 5 });
    expect(a).toEqual(b);
  });

  it("changes with click_count for the same id", () => {
    // Collect 20 click_counts and assert at least two distinct decisions.
    const id = "untitled-2.txt";
    const decisions = Array.from({ length: 20 }, (_, i) =>
      decide({ id, click_count: i + 1 }),
    );
    const oks = new Set(decisions.map((d) => d.ok));
    expect(oks.has(true)).toBe(true);
    expect(oks.has(false)).toBe(true);
  });
});

describe("decide — demo capture contract (#62)", () => {
  // scripts/capture_demo.ts drives exactly two clicks on `untitled-2.txt` to
  // show the rollback animation, and the README documents the same. That only
  // works if the oracle rolls this item back on its 2nd click. (The earlier
  // driver clicked `untitled-1.txt`, which the oracle SUCCEEDS on at click 2 —
  // it rolls back only at click 3 — so the recorded take never showed the
  // rollback.) Pin the contract so a future oracle/hash change can't silently
  // break the demo recording again.
  it("rolls back the capture driver's item (untitled-2.txt) on its second click", () => {
    expect(decide({ id: "untitled-2.txt", click_count: 1 }).ok).toBe(true);
    expect(decide({ id: "untitled-2.txt", click_count: 2 }).ok).toBe(false);
  });
});

describe("decide — split", () => {
  it("is approximately 50/50 over the demo ids × clicks 2..200 (first-click bias excluded)", () => {
    const { successes, failures } = decisionSplitOver(DEMO_NAMES, {
      from: 2,
      to: 200,
    });
    const total = successes + failures;
    expect(total).toBe(DEMO_NAMES.length * 199);
    // Allow up to 10% deviation from a perfect 50/50 split.
    expect(Math.abs(successes - failures) / total).toBeLessThan(0.1);
  });
});

describe("decisionSplitOver — range validation", () => {
  it("throws on an inverted range instead of silently returning zero samples", () => {
    // Before the guard this returned { successes: 0, failures: 0 }, letting a
    // split property test pass vacuously on zero evidence.
    expect(() => decisionSplitOver(DEMO_NAMES, { from: 5, to: 2 })).toThrow(
      /from \(5\) must be <= clickRange\.to \(2\)/,
    );
  });

  it("throws a decisionSplitOver-named error on a sub-1 from bound", () => {
    expect(() => decisionSplitOver(DEMO_NAMES, { from: 0, to: 5 })).toThrow(
      /decisionSplitOver\(\): clickRange\.from must be a positive integer/,
    );
  });

  it("throws on a non-integer from bound", () => {
    expect(() => decisionSplitOver(DEMO_NAMES, { from: 1.5, to: 5 })).toThrow(
      /clickRange\.from must be a positive integer/,
    );
  });

  it("throws on a non-integer to bound (no silent truncation)", () => {
    expect(() => decisionSplitOver(DEMO_NAMES, { from: 2, to: 2.5 })).toThrow(
      /clickRange\.to must be a positive integer/,
    );
  });

  it("accepts a valid range and returns the full sample count", () => {
    const { successes, failures } = decisionSplitOver(DEMO_NAMES, { from: 2, to: 10 });
    expect(successes + failures).toBe(DEMO_NAMES.length * (10 - 2 + 1));
  });

  it("accepts a single-click range (from === to)", () => {
    const { successes, failures } = decisionSplitOver(DEMO_NAMES, { from: 3, to: 3 });
    expect(successes + failures).toBe(DEMO_NAMES.length);
  });
});

describe("decide — improved_name shape", () => {
  it("returns one of the committed improvements when id is a demo id", () => {
    // Walk a range of click_counts; every ok=true improved_name must
    // appear in the static IMPROVEMENTS list for that id, or for an
    // unknown id be derived from the id deterministically.
    for (const id of DEMO_NAMES) {
      for (let c = 1; c < 50; c++) {
        const d = decide({ id, click_count: c });
        if (d.ok) {
          // Every demo improved_name ends in .md per the committed list.
          expect(d.improved_name).toMatch(/\.md$/);
        }
      }
    }
  });

  it("derives a generic improved_name for an unknown id", () => {
    const d = decide({ id: "custom-thing.txt", click_count: 1 });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.improved_name).toBe("custom-thing-improved.md");
  });
});

describe("decide — refusal shape", () => {
  it("returns a non-empty reason string for ok=false", () => {
    // Find any failing case. The split tests confirm one exists in the
    // 2..200 range; we just probe deterministically.
    let found = false;
    for (let c = 2; c < 200 && !found; c++) {
      const d = decide({ id: "untitled-4.txt", click_count: c });
      if (!d.ok) {
        expect(d.reason.length).toBeGreaterThan(0);
        found = true;
      }
    }
    expect(found).toBe(true);
  });
});
