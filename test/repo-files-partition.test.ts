import { describe, expect, it } from "vitest";

import { SOURCE_DIRS, repoFiles, sourceFiles } from "./support/source-files";

/**
 * The partition `readRepoFiles`' doc block describes, as a claim a test runs
 * (#132).
 *
 * That block justifies why `readRepoFiles` is a different population from
 * `readSourceFiles` by naming what `SOURCE_DIRS` misses: `test/`, `scripts/`,
 * and the root-level config files. It is the load-bearing argument of #130 and
 * #131 — and until #132 it said "the **five** root-level files" and listed
 * four.
 *
 * The enumeration was complete; only the count word was wrong, and no lock read
 * it. That is the interesting part: a number in prose beside a walker nobody
 * runs against it drifts silently, and the same wrong figure had already
 * propagated into `MEMORY/full_history_ai.md`, where the next session reasons
 * from it.
 *
 * So the number is not what this file pins. It pins the **claim**: everything
 * `repoFiles()` finds outside `SOURCE_DIRS` falls into exactly those three
 * buckets, with nothing left over. A future edit that adds a first-party
 * `.ts` file somewhere new — a `config/` directory, a second script dir — turns
 * this red, which is what the prose has been asserting all along without any
 * way to be wrong.
 */

/** The four root-level config files, by name. Pinned by value as well as by
 *  partition: the partition arm alone would stay green if one were deleted and
 *  another added, and the doc block names these four specifically. */
const ROOT_LEVEL_FILES = [
  "next-env.d.ts",
  "next.config.ts",
  "playwright.config.ts",
  "vitest.config.ts",
] as const;

function outsideSourceDirs(): string[] {
  const inSourceDirs = new Set(SOURCE_DIRS.flatMap((dir) => sourceFiles(dir)));
  return repoFiles()
    .filter((rel) => !inSourceDirs.has(rel))
    .sort();
}

describe("repoFiles partitions exactly as its doc block claims", () => {
  it("finds a non-empty corpus on both sides of the difference", () => {
    // Anti-vacuity, and the arm most worth having: every assertion below is
    // over `outsideSourceDirs()`, so a `repoFiles` that returned `[]` — or a
    // `sourceFiles` that returned everything — would satisfy all of them for
    // free. Pinned as lower bounds rather than exact counts, because the point
    // is that the sets are populated, not how big they are this week.
    const all = repoFiles();
    const outside = outsideSourceDirs();
    expect(all.length).toBeGreaterThan(outside.length);
    expect(outside.length).toBeGreaterThan(ROOT_LEVEL_FILES.length);
  });

  it("leaves nothing outside test/, scripts/ and the root-level files", () => {
    const unaccounted = outsideSourceDirs().filter(
      (rel) => !rel.startsWith("test/") && !rel.startsWith("scripts/") && rel.includes("/"),
    );
    expect(unaccounted).toEqual([]);
  });

  it("finds exactly the four root-level files the doc block names", () => {
    const root = outsideSourceDirs().filter((rel) => !rel.includes("/"));
    expect(root).toEqual([...ROOT_LEVEL_FILES]);
  });

  it("reaches both of the other two buckets", () => {
    // The partition arm above is satisfied by an empty `test/` or `scripts/`
    // slice — "nothing unaccounted for" is trivially true of a smaller set.
    // These two say the buckets the doc block names are actually reached, so
    // the sentence is not describing directories the walker never enters.
    const outside = outsideSourceDirs();
    expect(outside.filter((rel) => rel.startsWith("test/")).length).toBeGreaterThan(0);
    expect(outside.filter((rel) => rel.startsWith("scripts/")).length).toBeGreaterThan(0);
  });

  it("accounts for every file outside SOURCE_DIRS exactly once", () => {
    // The three buckets are disjoint and their union is the whole difference
    // set. Stated as an arithmetic identity rather than by re-listing, so it
    // holds at whatever counts the repo has on the day it runs — which is the
    // property the prose's "five" could not have.
    const outside = outsideSourceDirs();
    const root = outside.filter((rel) => !rel.includes("/"));
    const inTest = outside.filter((rel) => rel.startsWith("test/"));
    const inScripts = outside.filter((rel) => rel.startsWith("scripts/"));
    expect(root.length + inTest.length + inScripts.length).toBe(outside.length);
    expect(new Set([...root, ...inTest, ...inScripts]).size).toBe(outside.length);
  });
});
