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
