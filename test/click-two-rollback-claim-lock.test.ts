/**
 * "Rollback on click 2" names the items it is true for (#175).
 *
 * `decide()` never rolls back a first click, and from click 2 on it splits
 * 50/50 on a hash of (id, click_count). So click 2 rolls back on only 2 of the
 * 5 demo items. `app/api/optimistic/route.ts`, which the `/optimistic-rollback`
 * Source pane serves verbatim (D-004), said a visitor sees "a rollback
 * animation on click 2 if they try again", with no item named. That holds for
 * 2 items and is false for 3. The file shown next to it,
 * `lib/optimistic-decision.ts`, said "2 of the 5" correctly.
 *
 * #100/#163's lock (`fifty-fifty-claim-lock.test.ts`) only looks for the token
 * "50/50". This claim is a different shape, so it got past that lock. This
 * file checks it: wherever a reader-facing file pairs a second click with a
 * rollback, the same passage must name a click-2 rollback item or give the
 * 2-of-5 share. The item set comes from `decide()`, not from a list typed here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEMO_NAMES, decide } from "../lib/optimistic-decision";
import { ROOT, docFiles, readSourceFiles } from "./support/source-files";

/** The demo items whose second click rolls back, read off the oracle. */
const ROLLS_BACK_ON_CLICK_2 = DEMO_NAMES.filter((id) => !decide({ id, click_count: 2 }).ok);

/** A second click on one item, however the prose words it. */
const SECOND_CLICK = /click 2\b|second click|clicks? (?:one item|an item|it) twice|two clicks/gi;
const ROLLBACK = /roll(?:s|ed|ing)? ?back|rollback/i;
const WINDOW = 160;

/** Every file a reader reads: README, docs/, and the served SOURCE_DIRS files (as #163's walk). */
function readerFacingFiles(): Array<readonly [string, string]> {
  const markdown = ["README.md", ...docFiles()].map(
    (rel) => [rel, readFileSync(resolve(ROOT, rel), "utf8")] as const,
  );
  return [...markdown, ...readSourceFiles()];
}

/** Text around each second-click mention that also talks about a rollback. */
function claims(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SECOND_CLICK)) {
    const at = m.index ?? 0;
    const ctx = text.slice(Math.max(0, at - WINDOW), at + m[0].length + WINDOW);
    if (ROLLBACK.test(ctx)) out.push(ctx);
  }
  return out;
}

function qualified(ctx: string): boolean {
  const share = `${ROLLS_BACK_ON_CLICK_2.length} of the ${DEMO_NAMES.length}`;
  return (
    ROLLS_BACK_ON_CLICK_2.some((id) => ctx.includes(id)) ||
    ctx.includes(share) ||
    /\ba rollback item\b/i.test(ctx)
  );
}

describe("a 'rollback on click 2' claim names the items it holds for (#175)", () => {
  it("the oracle rolls back click 2 on some demo items and not all of them", () => {
    // If this ever becomes all-or-none, the qualifier below means something
    // else and the lock must be rethought, not silently pass.
    expect(ROLLS_BACK_ON_CLICK_2).toEqual(["untitled-2.txt", "untitled-4.txt"]);
    for (const id of DEMO_NAMES) expect(decide({ id, click_count: 1 }).ok).toBe(true);
  });

  it("finds claims to check, including the served route's", () => {
    // Anti-vacuity: a walk that read nothing, or a needle that matched
    // nothing, would pass the check below.
    const files = readerFacingFiles();
    expect(files.map(([rel]) => rel)).toEqual(
      expect.arrayContaining(["README.md", "app/api/optimistic/route.ts", "lib/optimistic-decision.ts"]),
    );
    const sites = files.filter(([, text]) => claims(text).length > 0).map(([rel]) => rel);
    expect(sites).toEqual(
      expect.arrayContaining(["README.md", "app/api/optimistic/route.ts", "lib/optimistic-decision.ts"]),
    );
  });

  it("every reader-facing claim names a click-2 rollback item or the share", () => {
    const offenders = readerFacingFiles().flatMap(([rel, text]) =>
      claims(text)
        .filter((c) => !qualified(c))
        .map((c) => `${rel}: ${JSON.stringify(c)}`),
    );
    expect(
      offenders,
      `a second click rolls back on only ${ROLLS_BACK_ON_CLICK_2.join(", ")} ` +
        `(${ROLLS_BACK_ON_CLICK_2.length} of ${DEMO_NAMES.length} demo items)`,
    ).toEqual([]);
  });
});
