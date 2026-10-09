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
 * visitor who clicks one item twice sees the rollback on **2 of 5** items
 * (40%), and the file's own header says that path "can't be a rare event; it
 * has to fire reliably enough for a casual visitor to observe it". (#100 wrote
 * 20% here: the share of the ten (id, click) pairs over clicks 1..2 that fail,
 * which is not a rate any visitor sees -- #163.)
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
import { docFiles, readSourceFiles } from "./support/source-files";

const ROOT = resolve(__dirname, "..");

/**
 * The four sites #100 fixed. Kept as a FLOOR (`arrayContaining` below), not as
 * the population: it was the population until #163, under the comment "Every
 * file that states the property to a reader", and the homepage's
 * `/optimistic-rollback` card in `app/page.tsx` -- the first page every visitor
 * sees -- said "a deterministic 50/50 decision oracle" with no qualifier while
 * this lock was green, because it never read that file. A hand-transcribed
 * list can notice a member leaving; it cannot notice one it was never told
 * about (the same lesson as D-015).
 */
const CLAIM_SITES = [
  "README.md",
  "docs/architecture.md",
  "app/optimistic-rollback/page.tsx",
  "lib/optimistic-decision.ts",
] as const;

/**
 * Every file a reader reads, derived rather than listed (#163): the README,
 * every markdown file under `docs/`, and every `SOURCE_DIRS` file -- the served
 * pages and components, and the `lib/` and `app/api/` files the pattern pages
 * render in their source panes (D-004).
 *
 * Not `test/` (this file quotes the bare phrase to describe it) and not
 * `MEMORY/` (append-only history that records what the prose used to say).
 * Not `scripts/` either: `capture_demo.ts` is neither served nor shown in a
 * source pane.
 */
function readerFacingFiles(): Array<readonly [string, string]> {
  const markdown = ["README.md", ...docFiles()].map(
    (rel) => [rel, readFileSync(resolve(ROOT, rel), "utf8")] as const,
  );
  return [...markdown, ...readSourceFiles()];
}

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

  it("every reader-facing file qualifies every 50/50 claim (#163)", () => {
    const files = readerFacingFiles();
    const offenders = files.flatMap(([rel, text]) =>
      claimContexts(text)
        .filter((c) => !QUALIFIER.test(c))
        .map((c) => `${rel}: ${JSON.stringify(c.slice(0, 160))}`),
    );
    expect(
      offenders,
      `"50/50" without D-010's first-click qualifier nearby. The split is 50/50 ` +
        `only for click_count >= 2; a first click never rolls back.`,
    ).toEqual([]);
  });

  it("the derived population covers the hand-listed sites and the homepage (#163)", () => {
    // The floor notices a site LEAVING the walk (a renamed docs dir, a narrowed
    // SOURCE_DIRS); the derivation above notices one ENTERING. app/page.tsx is
    // named because it is the site the hand list missed.
    const walked = readerFacingFiles().map(([rel]) => rel);
    expect(walked).toEqual(
      expect.arrayContaining([...CLAIM_SITES, "app/page.tsx"]),
    );
    const claims = readerFacingFiles().reduce(
      (n, [, text]) => n + claimContexts(text).length,
      0,
    );
    // Anti-vacuity: a walk that read nothing would pass the check above it.
    expect(claims).toBeGreaterThanOrEqual(10);
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

  it("two clicks on one item roll back on 2 of the 5 items -- 40%, not the 20% #100 wrote (#163)", () => {
    // 20% is failures / (id, click) pairs over clicks 1..2 (2 of 10). What a
    // visitor who clicks one item twice experiences is the share of ITEMS
    // whose second click fails.
    const rolledBack = DEMO_NAMES.filter((id) => !decide({ id, click_count: 2 }).ok);
    expect(rolledBack).toEqual(["untitled-2.txt", "untitled-4.txt"]);
    expect(rolledBack.length / DEMO_NAMES.length).toBe(0.4);
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
