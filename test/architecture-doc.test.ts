// Snapshot test for docs/architecture.md (#18).
//
// Before #18, the architecture doc still showed only the streaming-text
// pattern in its directory diagram and listed the other four patterns
// (tool-use, partial-json, optimistic-rollback, error-recovery) as
// `pending` or `(unfiled)` — even though all five shipped weeks ago,
// and the README's own Patterns table (locked by
// readme-patterns-table.test.ts) already enumerates all five.
//
// This test locks four invariants on `docs/architecture.md`:
//
//   1. Every `app/<slug>/` path token in the doc resolves to a real
//      directory.
//   2. Every pattern in `app/page.tsx`'s `PATTERNS` array has its slug
//      (the `/<slug>` portion) referenced at least once in the doc, so
//      a future sixth pattern can't ship without the architecture doc
//      updating to mention it.
//   3. Every non-superseded `D-NNN` in `MEMORY/core_decisions_ai.md`
//      whose numeric id is `>= MIN_ACTIVE_DECISION_ID` is referenced
//      at least once. The next `D-NNN` landing without a doc update
//      fails this test loud — sister to `agent-orchestration-platform`,
//      `llm-eval-harness` PR #32, and the other 7 Python sisters
//      this week.
//   4. None of three banned phrases appear: `(unfiled)`, `to-be-filed`,
//      and `pending patterns` (case-insensitive). These were the exact
//      shapes of the pre-#18 staleness; locking absence means a future
//      copy-paste from an old revision can't silently reintroduce the
//      bug.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const ARCH_PATH = resolve(ROOT, "docs/architecture.md");
const HOMEPAGE_PATH = resolve(ROOT, "app/page.tsx");
const DECISIONS_PATH = resolve(ROOT, "MEMORY/core_decisions_ai.md");

// D-001 is the scope baseline (handoff §2) and isn't tied to a shipped
// code surface; it doesn't need to be cited in architecture.md. Every
// active D-NNN with id >= MIN_ACTIVE_DECISION_ID does.
const MIN_ACTIVE_DECISION_ID = 2;

// The exact substrings the pre-#18 doc carried that signaled drift.
// Matched case-insensitively so a future copy with slight capitalization
// (e.g., "Pending Patterns") is still caught.
const BANNED_PHRASES: ReadonlyArray<string> = [
  "(unfiled)",
  "to-be-filed",
  "Pending patterns",
] as const;

/** Extract slugs of the form `app/<slug>/` from a markdown source. */
function appSlugRefs(md: string): string[] {
  const re = /app\/([a-z0-9][a-z0-9-]*[a-z0-9])\/?/g;
  const slugs = new Set<string>();
  for (const m of md.matchAll(re)) {
    slugs.add(m[1]);
  }
  return [...slugs].sort();
}

/** Parse `MEMORY/core_decisions_ai.md` for non-superseded `D-NNN`
 *  entries whose numeric id is `>= MIN_ACTIVE_DECISION_ID`. Returns a
 *  sorted array of numeric ids.
 */
function activeDecisions(decisionsText: string): number[] {
  const blocks = decisionsText.split(/\n(?=- id:)/);
  const active: number[] = [];
  for (const block of blocks) {
    const idMatch = block.match(/- id:\s*D-(\d+)/);
    if (!idMatch) continue;
    const supMatch = block.match(/superseded_by:\s*(\S+)/);
    const isActive = supMatch === null || supMatch[1].trim().toLowerCase() === "null";
    if (isActive) {
      const n = Number(idMatch[1]);
      if (n >= MIN_ACTIVE_DECISION_ID) active.push(n);
    }
  }
  return active.sort((a, b) => a - b);
}

/** Extract referenced `D-NNN` ids from doc text. */
function referencedDecisions(md: string): Set<number> {
  const re = /\bD-0*(\d+)\b/g;
  const found = new Set<number>();
  for (const m of md.matchAll(re)) {
    found.add(Number(m[1]));
  }
  return found;
}

/** Parse the `slug:` field of every object in `PATTERNS` and return
 *  the leading-slash-stripped slug. The homepage source declares the
 *  array as an object literal — this is a small string-level parser,
 *  not a TS evaluator, but it's robust against reordering and against
 *  status/issue/description edits because it only reads the `slug:` key.
 */
function homepageSlugs(source: string): string[] {
  const slugs: string[] = [];
  const re = /slug:\s*"\/([a-z0-9][a-z0-9-]*[a-z0-9])"/g;
  for (const m of source.matchAll(re)) {
    slugs.push(m[1]);
  }
  return slugs;
}

describe("docs/architecture.md is current with the shipped patterns", () => {
  const md = readFileSync(ARCH_PATH, "utf8");
  const homepage = readFileSync(HOMEPAGE_PATH, "utf8");

  it("every app/<slug>/ token in the doc resolves to an existing directory", () => {
    const refs = appSlugRefs(md);
    expect(refs.length, "expected at least one app/<slug>/ reference").toBeGreaterThan(0);
    const missing = refs.filter((slug) => !existsSync(resolve(ROOT, "app", slug)));
    expect(
      missing,
      "architecture doc references app/<slug>/ directories that don't exist; " +
        "either create the directory or remove the reference",
    ).toEqual([]);
  });

  it("every PATTERNS slug in the homepage is referenced in the architecture doc", () => {
    const slugs = homepageSlugs(homepage);
    expect(
      slugs.length,
      "homepage PATTERNS array yielded no slugs — parser misalignment with app/page.tsx",
    ).toBeGreaterThan(0);
    const refs = appSlugRefs(md);
    const unreferenced = slugs.filter((slug) => !refs.includes(slug));
    expect(
      unreferenced,
      "PATTERNS entries that are not mentioned in docs/architecture.md: " +
        `${JSON.stringify(unreferenced)}. ` +
        "Each shipped pattern in app/page.tsx must appear in the architecture doc.",
    ).toEqual([]);
  });

  it.each(BANNED_PHRASES)(
    "does not contain the stale phrase %j",
    (phrase: string) => {
      // Case-insensitive search so a capitalized variant ("Pending Patterns")
      // is still caught — the original drift was the exact phrase but a
      // future copy-paste could shift case.
      const lower = md.toLowerCase();
      const needle = phrase.toLowerCase();
      expect(
        lower.includes(needle),
        `architecture doc contains banned phrase "${phrase}", which was a ` +
          "specific shape of pre-#18 drift. If a different context legitimately " +
          "requires this string, update BANNED_PHRASES in this test with a comment.",
      ).toBe(false);
    },
  );

  it("BANNED_PHRASES is the exact set of three shapes from #18", () => {
    // Hard-pin the banned set so a future loose edit can't silently drop one.
    expect([...BANNED_PHRASES]).toEqual([
      "(unfiled)",
      "to-be-filed",
      "Pending patterns",
    ]);
  });

  it("has a MEMORY/core_decisions_ai.md to parse", () => {
    expect(
      existsSync(DECISIONS_PATH),
      "MEMORY/core_decisions_ai.md is the source of truth for the active-decision-range axis; it must exist",
    ).toBe(true);
  });

  it("references every active D-NNN in MEMORY/core_decisions_ai.md at least once", () => {
    const decisionsText = readFileSync(DECISIONS_PATH, "utf8");
    const active = activeDecisions(decisionsText);
    const referenced = referencedDecisions(md);
    const missing = active.filter((n) => !referenced.has(n));
    expect(
      missing,
      `docs/architecture.md doesn't reference these active (non-superseded) core decisions even once: ${missing
        .map((n) => `D-${String(n).padStart(3, "0")}`)
        .join(", ")}. ` +
        "Every shipped layer / posture in MEMORY/core_decisions_ai.md should be annotated in the doc where the relevant code lives; add a D-NNN reference to the relevant bullet.",
    ).toEqual([]);
  });

  it("MIN_ACTIVE_DECISION_ID is hard-pinned to 2", () => {
    // Locks the baseline-skip threshold so a future loose edit can't silently
    // weaken or strengthen the guard.
    expect(MIN_ACTIVE_DECISION_ID).toBe(2);
  });
});
