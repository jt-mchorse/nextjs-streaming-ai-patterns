// Snapshot test for docs/architecture.md (#18).
//
// Before #18, the architecture doc still showed only the streaming-text
// pattern in its directory diagram and listed the other four patterns
// (tool-use, partial-json, optimistic-rollback, error-recovery) as
// `pending` or `(unfiled)` — even though all five shipped weeks ago,
// and the README's own Patterns table (locked by
// readme-patterns-table.test.ts) already enumerates all five.
//
// This test locks three invariants on `docs/architecture.md`:
//
//   1. Every `app/<slug>/` path token in the doc resolves to a real
//      directory.
//   2. Every pattern in `app/page.tsx`'s `PATTERNS` array has its slug
//      (the `/<slug>` portion) referenced at least once in the doc, so
//      a future sixth pattern can't ship without the architecture doc
//      updating to mention it.
//   3. None of three banned phrases appear: `(unfiled)`, `to-be-filed`,
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
});
