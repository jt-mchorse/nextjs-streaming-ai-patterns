/**
 * The "50/50" claim always carries D-010's first-click qualifier (#100).
 *
 * D-010's rationale states the property correctly —
 * `first_click_bias_keeps_happy_path_visible_first_subsequent_clicks_split_5050_via_fnv1a_low_bit`
 * — and every restatement but one dropped the "subsequent clicks" half:
 * `lib/optimistic-decision.ts` (twice), `README.md` (twice),
 * `docs/architecture.md` (twice), and the copy a visitor actually reads at
 * `app/optimistic-rollback/page.tsx:29`. The same page carried both the
 * correct and the incorrect version, 28 lines apart.
 *
 * That is not a nitpick about wording. Measured over the five demo ids, a
 * visitor who clicks twice sees the rollback **20%** of the time, and the
 * file's own header says that path "can't be a rare event; it has to fire
 * reliably enough for a casual visitor to observe it".
 *
 * This test is a drift lock in the same shape as the architecture-doc and
 * README-patterns locks, because drift is exactly what happened: the qualifier
 * was correct at the decision and lost on the way out to the reader.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEMO_NAMES,
  decide,
  decisionSplitOver,
} from "../lib/optimistic-decision";

const ROOT = resolve(__dirname, "..");

/** Every file that states the property to a reader. */
const CLAIM_SITES = [
  "README.md",
  "docs/architecture.md",
  "app/optimistic-rollback/page.tsx",
  "lib/optimistic-decision.ts",
] as const;

/**
 * Words that, near a "50/50", show the qualifier survived. Deliberately a
 * family rather than one exact phrase — the sites word it differently and
 * pinning one string would just move the drift somewhere else.
 */
const QUALIFIER =
  /first[- ]click|click 1|click_count >= 2|subsequent|after click/i;

/** How much text around a claim counts as "near" it. */
const WINDOW = 240;

function claimContexts(text: string): string[] {
  const out: string[] = [];
  const needle = "50/50";
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push(text.slice(Math.max(0, i - WINDOW), i + WINDOW));
    i = text.indexOf(needle, i + needle.length);
  }
  return out;
}

describe("the 50/50 claim carries D-010's qualifier (#100)", () => {
  it("finds claims to check", () => {
    // Guards the guard: a rename or a rewrite that removed every "50/50"
    // would make every assertion below vacuously true.
    const total = CLAIM_SITES.reduce(
      (n, rel) =>
        n + claimContexts(readFileSync(resolve(ROOT, rel), "utf8")).length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(6);
  });

  it.each(CLAIM_SITES)("%s qualifies every 50/50 claim", (rel) => {
    const text = readFileSync(resolve(ROOT, rel), "utf8");
    const unqualified = claimContexts(text).filter((c) => !QUALIFIER.test(c));
    expect(
      unqualified,
      `${rel} states "50/50" without D-010's first-click qualifier nearby. The ` +
        `split is 50/50 only for click_count >= 2; over clicks 1..2 it is 80/20. ` +
        `Offending context(s): ${unqualified.map((c) => JSON.stringify(c.slice(0, 160))).join(" || ")}`,
    ).toEqual([]);
  });

  it("the decision record itself still states it correctly", () => {
    // If D-010 is ever reworded, this lock is measuring against a moved target.
    const decisions = readFileSync(
      resolve(ROOT, "MEMORY/core_decisions_ai.md"),
      "utf8",
    );
    expect(decisions).toContain("subsequent_clicks_split_5050");
  });
});

describe("the measured split, on the record (#100)", () => {
  it("is exactly even for click_count >= 2", () => {
    expect(decisionSplitOver(DEMO_NAMES, { from: 2, to: 11 })).toEqual({
      successes: 25,
      failures: 25,
    });
    expect(decisionSplitOver(DEMO_NAMES, { from: 2, to: 1001 })).toEqual({
      successes: 2500,
      failures: 2500,
    });
  });

  it("is 80/20 over a two-click session — the number the page used to contradict", () => {
    expect(decisionSplitOver(DEMO_NAMES, { from: 1, to: 2 })).toEqual({
      successes: 8,
      failures: 2,
    });
  });

  it("never rolls back on a first click", () => {
    expect(decisionSplitOver(DEMO_NAMES, { from: 1, to: 1 })).toEqual({
      successes: 5,
      failures: 0,
    });
    for (const id of DEMO_NAMES) {
      expect(decide({ id, click_count: 1 }).ok).toBe(true);
    }
  });
});

describe("decisionSplitOver guards both operands of its product (#100)", () => {
  it("rejects an empty ids", () => {
    // Pre-fix this returned { successes: 0, failures: 0 } — the exact vacuous
    // result the clickRange guard's own comment says must fail loud, reached
    // through the operand that guard does not mention.
    expect(() => decisionSplitOver([], { from: 1, to: 10 })).toThrow(
      /decisionSplitOver\(\): ids must be non-empty/,
    );
  });

  it("still rejects a degenerate clickRange", () => {
    expect(() => decisionSplitOver(DEMO_NAMES, { from: 5, to: 2 })).toThrow(
      /decisionSplitOver\(\): clickRange\.from \(5\) must be <= clickRange\.to \(2\)/,
    );
  });

  it("reports the ids problem before the clickRange one", () => {
    // Both operands degenerate: the message should name the container that is
    // empty rather than send the caller after the range.
    expect(() => decisionSplitOver([], { from: 5, to: 2 })).toThrow(
      /ids must be non-empty/,
    );
  });

  it("still accepts a single id and a single click", () => {
    expect(decisionSplitOver([DEMO_NAMES[0]], { from: 3, to: 3 })).toEqual({
      successes: expect.any(Number),
      failures: expect.any(Number),
    });
  });

  it("degenerate ids elements were already covered by decide", () => {
    // Recording that this half needed no change: the empty *container* was the
    // gap, not the elements.
    expect(() => decisionSplitOver([""], { from: 1, to: 2 })).toThrow(
      /decide\(\): id must be a non-empty string/,
    );
  });
});
