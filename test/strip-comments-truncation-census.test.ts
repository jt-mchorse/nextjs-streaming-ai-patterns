import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT, sourceFiles, stripComments } from "./support/source-files";

/**
 * Census of every line `stripComments` truncates, repo-wide (#127, D-014).
 *
 * `stripComments` drops everything after the first `/`+`/` that is not preceded
 * by `:`. Three constructs can produce such a pair without a comment being
 * present, and `test/support/source-files.ts` declares them rather than lexing
 * for them — a position D-014 keeps deliberately. What D-014 does *not* keep is
 * the old claim that the declared limits are unreachable:
 *
 *   - a protocol-relative URL. Genuinely unreachable; nothing in the repo has one.
 *   - a `/`+`/` inside an ordinary string literal. Declared "not reachable in this
 *     repo" and reachable **22 times across 4 files**.
 *   - a `/`+`/` produced by a regex literal whose body ends `\*\/` before a flag
 *     group. Not declared at all, and reachable **5 times across 3 files** —
 *     including `stripComments`' own definition line.
 *
 * The reason the old claim read as true is that its two reachability probes call
 * `readSourceFiles()`, whose population is `SOURCE_DIRS` = `lib` + `components` +
 * `app`. Over *that* population the claim is correct and still is. But the
 * structural locks in `test/strip-comments.test.ts` run `stripComments` over
 * **test** files, and that is where all of them live. The probes guarded
 * the population that is not affected and left the affected one unscanned — the
 * claim was not wrong about its corpus, it was scoped to the wrong corpus.
 *
 * So this census scans every directory whose files are ever passed through
 * `stripComments` by any lock, pins the result per file and per cause, and keeps
 * a separately-named arm on the shipped-source slice. A `lib`/`components`/`app`
 * file entering the set must fail on its own assertion with its own message,
 * not as one changed element inside a 27-entry diff — that is the case where a
 * truncation would silently weaken a lock over shipped code.
 *
 * This file is written so that it contributes **zero** entries to its own census:
 * every `/`+`/` it needs is built by concatenation rather than written as a
 * literal. Without that the pinned numbers would move every time this file is
 * edited, and a census that churns on its own maintenance is one nobody reads.
 * `assertThisFileIsNotInTheCensus` below pins that property rather than trusting it.
 */

const SLASH = "/";
const COMMENT_OPEN = SLASH + SLASH;

/** Directories whose files any lock passes through `stripComments`. */
const SCANNED_DIRS = ["lib", "components", "app", "test", "scripts"] as const;

/** The slice where a truncation would weaken a lock over *shipped* code. */
const SHIPPED_DIRS = ["lib", "components", "app", "scripts"] as const;

type Cause = "string-literal" | "regex-literal";
type Finding = { file: string; line: number; cause: Cause };

/**
 * Every position where `stripComments` would cut a line that holds no comment.
 *
 * A whole-file walk, not a per-line one, and the difference is load-bearing: a
 * line-local scanner reads the prose inside a multi-line JSDoc block as string
 * content and reported 5 false positives in `test/support/source-files.ts`
 * alone. Block-comment state only exists across lines.
 *
 * This is a lexer, which `stripComments` itself deliberately is not. That is not
 * a contradiction — D-014's argument is that the *stripper* must stay cheap and
 * declare its limits, because it runs inside every lock. A census runs once and
 * can afford to be strict about the thing the stripper is honest about guessing.
 */
export function findTruncations(
  src: string,
): Array<{ line: number; cause: Cause }> {
  const out: Array<{ line: number; cause: Cause }> = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let prev = "";

  const isCommentOpenAt = (k: number): boolean =>
    src[k] === SLASH && src[k + 1] === SLASH && src[k - 1] !== ":";

  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    // Block comment: consumed wholesale, and it may span lines.
    if (c === SLASH && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === SLASH)) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    // A real line comment: the rule is correct here, nothing is lost.
    if (isCommentOpenAt(i) || (src[i] === SLASH && src[i + 1] === SLASH)) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // String or template literal.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "\n") line++;
        if (isCommentOpenAt(i)) out.push({ line, cause: "string-literal" });
        i++;
      }
      i++;
      prev = quote;
      continue;
    }
    // Regex literal, recognised by what may legally precede one.
    if (c === SLASH && (prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev))) {
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") {
          // The #127 shape: an escaped slash immediately before the closing
          // delimiter, e.g. a body ending `\*\/` followed by a flag group.
          if (src[i + 1] === SLASH && src[i + 2] === SLASH && src[i] !== ":") {
            out.push({ line, cause: "regex-literal" });
          }
          i += 2;
          continue;
        }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === SLASH && !inClass) {
          if (src[i + 1] === SLASH && src[i - 1] !== ":") {
            out.push({ line, cause: "regex-literal" });
          }
          i++;
          break;
        }
        i++;
      }
      prev = SLASH;
      continue;
    }
    if (c.trim() !== "") prev = c;
    i++;
  }
  return out;
}

function census(): Finding[] {
  const found: Finding[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const rel of sourceFiles(dir, ROOT)) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const hit of findTruncations(text))
        found.push({ file: rel, ...hit });
    }
  }
  return found;
}

function countsByFile(findings: Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.file] = (out[f.file] ?? 0) + 1;
  return out;
}

/**
 * Pinned per file, not per `file:line`.
 *
 * Line numbers move when a file is edited for unrelated reasons, and a census
 * that goes red on every neighbouring edit gets updated without being read —
 * which is the failure mode this whole issue is an instance of. A per-file count
 * still makes growth loud, which is what the acceptance criterion asks for.
 *
 * Measured 2026-09-14 over 71 files: 27 truncations before this change,
 * 26 after the `readme-patterns-table.test.ts` rewrite, every one in `test/`.
 */
const EXPECTED_COUNTS: Record<string, number> = {
  "test/api-routes-accept-plain-request.test.ts": 4,
  "test/stream-delay-defaults.test.ts": 1,
  "test/strip-comments.test.ts": 20,
  "test/support/source-files.ts": 1,
};

describe("stripComments truncation census (#127, D-014)", () => {
  it("the scan finds files at all (anti-vacuous)", () => {
    const scanned = SCANNED_DIRS.flatMap((d) => sourceFiles(d, ROOT));
    expect(
      scanned.length,
      "the directory walk found nothing; the census below is empty for the wrong reason",
    ).toBeGreaterThan(50);
  });

  it("no file under lib/ components/ app/ scripts/ is ever truncated", () => {
    const shipped = census().filter((f) =>
      SHIPPED_DIRS.some((d) => f.file.startsWith(`${d}/`)),
    );
    expect(
      shipped.map((f) => `${f.file}:${f.line} (${f.cause})`),
      "a shipped-source file now contains a " +
        COMMENT_OPEN +
        " inside a string or regex literal. Every structural lock reads that file " +
        "through stripComments and will silently see the line cut short at that " +
        "point. Rewrite the literal (a character class instead of an escaped " +
        "slash, or split the string) rather than widening the stripper — see D-014.",
    ).toEqual([]);
  });

  it("the per-file truncation counts are exactly the pinned set", () => {
    expect(
      countsByFile(census()),
      "the set of truncated lines changed. If a file gained one, rewrite the " +
        "literal rather than updating this number by reflex: the point of the " +
        "census is that growth is a decision, not a diff. If a file lost one, " +
        "lower the count here in the same commit.",
    ).toEqual(EXPECTED_COUNTS);
  });

  it("the census total and its split by cause are pinned", () => {
    const all = census();
    const byCause = { "string-literal": 0, "regex-literal": 0 };
    for (const f of all) byCause[f.cause]++;
    expect(all.length).toBe(26);
    expect(byCause).toEqual({ "string-literal": 22, "regex-literal": 4 });
  });

  it("this census file contributes nothing to its own census", () => {
    // Pinned rather than assumed. Every `/`+`/` above is built by concatenation
    // precisely so the numbers do not move when this file is edited; if someone
    // writes one as a literal, the pinned counts start churning on their own
    // maintenance and stop being read.
    const self = "test/strip-comments-truncation-census.test.ts";
    const text = readFileSync(join(ROOT, self), "utf8");
    expect(findTruncations(text)).toEqual([]);
  });

  it("finds a constructed offender of each cause (anti-vacuous)", () => {
    const inRegex = "const re = " + SLASH + "\\*\\" + SLASH + SLASH + "g;";
    expect(findTruncations(inRegex).map((h) => h.cause)).toEqual([
      "regex-literal",
    ]);

    const inString = 'const s = "a ' + COMMENT_OPEN + ' b"; const t = 1;';
    expect(findTruncations(inString).map((h) => h.cause)).toEqual([
      "string-literal",
    ]);

    // And it must stay quiet on the things that are not truncations, or it is a
    // tripwire rather than a census.
    expect(
      findTruncations("const a = 1; " + COMMENT_OPEN + " a real comment"),
    ).toEqual([]);
    expect(
      findTruncations('const u = "https:' + COMMENT_OPEN + 'x.com/y";'),
    ).toEqual([]);
    expect(
      findTruncations("/* " + COMMENT_OPEN + " inside a block comment */"),
    ).toEqual([]);
    expect(findTruncations('const r = "no slashes here";')).toEqual([]);
  });

  it("agrees with what stripComments actually does to a constructed line", () => {
    // The census claims a position is cut. Corroborate against the real helper
    // rather than only against this file's model of it.
    const line = 'const s = "a ' + COMMENT_OPEN + ' b"; const t = 1;';
    expect(findTruncations(line).length).toBe(1);
    // Note the kept trailing space: the rule's `(^|[^:])` capture preserves the
    // character before the cut, so the truncation boundary is one char earlier
    // than the `/`+`/` itself.
    expect(stripComments(line)).toBe('const s = "a ');
  });
});
