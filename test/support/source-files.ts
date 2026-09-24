/**
 * One definition of "where this repo's source lives", shared by the test-side
 * structural locks (#118).
 *
 * Two locks needed this and had two answers. `architecture-doc.test.ts` walked
 * `["lib", "components", "app"]` recursively; `sse-decoder-flush.test.ts`
 * listed `["lib", "components"]` one level deep. The second is the population
 * a guard shipped in #115 was scanning while claiming to cover every SSE read
 * path — and `app/api/` is exactly where a route that proxies an upstream
 * stream would decode one.
 *
 * The fix is a shared definition rather than a second correct copy: a lock
 * whose population can quietly disagree with the next lock's is how a partial
 * adoption slips through, which is the shape #114 → #115 had just finished
 * chasing.
 *
 * Deliberately test-side, not shipped: nothing in `lib/` needs to enumerate
 * the repo's own files, and putting it there would widen the public surface
 * `public-surface.test.ts` locks.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(__dirname, "..", "..");

/** Every directory holding first-party source. `app` is in the list because
 *  route handlers are source: they are the server half of every pattern in
 *  this repo. */
export const SOURCE_DIRS = ["lib", "components", "app"] as const;

export const SOURCE_EXTS = [".ts", ".tsx"] as const;

/**
 * Every source file under *dir*, recursively, as a path relative to *root*.
 *
 * Recursive on purpose. `readdirSync(base)` returns one level, so a
 * subdirectory added to `lib/` or `components/` drops out of a caller's
 * population with no error and no warning — just a smaller set, which reads
 * exactly like a clean scan.
 */
export function sourceFiles(dir: string, root: string = ROOT): string[] {
  const abs = resolve(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel, root));
    else if (SOURCE_EXTS.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out;
}

/** Every source file across every `SOURCE_DIRS` entry, as `[relPath, text]`. */
export function readSourceFiles(root: string = ROOT): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const dir of SOURCE_DIRS) {
    for (const rel of sourceFiles(dir, root)) {
      out.push([rel, readFileSync(join(root, rel), "utf8")]);
    }
  }
  return out;
}

/**
 * Every first-party `.ts`/`.tsx` file in the repo, as `[relPath, text]`.
 *
 * A **different population** from `readSourceFiles`, deliberately, and the two
 * must not be collapsed into each other (#130):
 *
 * - `readSourceFiles` walks `SOURCE_DIRS` — `lib`, `components`, `app` — and
 *   means *shipped source*. That is the right corpus for a lock about what the
 *   application does at runtime.
 * - `readRepoFiles` walks the whole repo and means *the repo*. That is the
 *   right corpus for a lock whose name says "in the repo" — a structural claim
 *   about the codebase rather than about the running application.
 *
 * `SOURCE_DIRS` reaches neither `test/`, nor `scripts/`, nor the four
 * root-level files (`next.config.ts`, `playwright.config.ts`,
 * `vitest.config.ts`, `next-env.d.ts`). A lock that widened only to the dirs
 * `SOURCE_DIRS` names would still walk a corpus smaller than its own claim,
 * which is the family of defect #123 → #125 → #126 → #127 → #130 is made of.
 *
 * That sentence said "five" and listed four until #132. The enumeration was
 * complete -- `test/` + `scripts/` + the root files really are the whole of
 * what `SOURCE_DIRS` misses, 41 + 1 + 4 = 46 of 76 -- so only the count word
 * was wrong, and no lock read it. It is now a claim a test runs rather than a
 * number in prose: `test/repo-files-partition.test.ts` asserts the difference
 * set partitions exactly three ways with nothing left over, which is what the
 * sentence is a summary of.
 *
 * Same exclusions as `sourceFiles`: `node_modules` and any dot-prefixed entry
 * (which is what keeps `.next/` and `.git/` out).
 */
export function repoFiles(root: string = ROOT, dir = ""): string[] {
  const abs = dir === "" ? resolve(root) : resolve(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...repoFiles(root, rel));
    else if (SOURCE_EXTS.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out;
}

/** `repoFiles`, read. */
export function readRepoFiles(root: string = ROOT): Array<readonly [string, string]> {
  return repoFiles(root).map((rel) => [rel, readFileSync(join(root, rel), "utf8")] as const);
}

/**
 * Strip comments so a source rule matches *code* and not prose (#123).
 *
 * Five locks each defined their own copy, and they had already diverged into
 * two spellings:
 *
 *     sse-framing-parity, sse-decoder-flush, stream-delay-defaults
 *       replace(SLASH ^\s*\/\/.*$ SLASH gm, "")  - whole-line comments only
 *     streaming-client-cleanup, error-recovery-resume-seam
 *       replace(SLASH \/\/[^\n]* SLASH g,  "")  - also trailing, after code
 *
 * `sse-decoder-flush.test.ts` said of its copy "Same comment-stripping rule
 * `sse-framing-parity.test.ts` uses" — a parity claim in prose, true of that
 * pair and false of the other three. Measured: the two spellings disagree on
 * **18 of the repo's 30 source files**, so this was not academic.
 *
 * The rule is decided on the merits rather than by the majority spelling. A
 * trailing `// ...` after code is prose, and for a lock stated as "must be
 * PRESENT" the lenient spelling lets that prose satisfy the rule — a trailing
 * `// we removed DEFAULT_BASE_DELAY_MS` keeps `stream-delay-defaults` green.
 * That is a false PASS, and the direction that matters here, because these
 * locks are mostly positive.
 *
 * So: strip trailing comments too, with one exception. A `//` preceded by `:`
 * is a URL scheme, and the unguarded strict spelling truncates the rest of the
 * line — measured, `app/layout.tsx` has exactly such a line today, and it is
 * the only file in the repo where the guarded and unguarded strict spellings
 * differ.
 *
 * Three limits are DECLARED rather than modelled, because a helper that
 * pretends to lex is worse than one whose limits are written down (D-014):
 *
 *   - a protocol-relative URL (`"//cdn.example.com/x"`) is truncated;
 *   - a `//` inside an ordinary string literal (`"a // b"`) is truncated;
 *   - a regex literal whose body ends `\*\/` before its flag group is
 *     truncated, because the escaped slash and the closing delimiter are two
 *     adjacent slashes. That is this function's own definition line (#127).
 *
 * These are MEASURED, not asserted unreachable. The previous wording said
 * "neither is reachable in this repo", and the third case was not listed at
 * all. The claim was not careless — its two reachability probes really do come
 * back empty — but they run over `readSourceFiles()`, whose population is
 * `SOURCE_DIRS` (`lib` + `components` + `app`). The structural locks in
 * `test/strip-comments.test.ts` pass **test** files through `stripComments`,
 * and every truncation in the repo is in a test file. The probes guarded the
 * corpus that is not affected and left the affected one unscanned.
 *
 * `test/strip-comments-truncation-census.test.ts` now walks every directory any
 * lock strips — `lib`, `components`, `app`, `test`, `scripts` — and pins the
 * count per file, with a separately-named arm asserting the shipped-source
 * slice is empty. Measured 2026-09-14: 26 truncations, all in `test/`.
 * `test/strip-comments.test.ts` still pins the known-wrong answers.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
