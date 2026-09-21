/**
 * The one comment-stripping rule, and its declared limits (#123).
 *
 * Five locks each defined their own `stripComments`, and they had already
 * diverged into two spellings — one stripping whole-line comments only, one
 * also stripping a trailing comment after code. `sse-decoder-flush.test.ts`
 * even said of its copy "Same comment-stripping rule `sse-framing-parity`
 * uses": a parity claim in prose, true of that pair and false of the other
 * three.
 *
 * Measured before consolidating: the two spellings disagree on **18 of this
 * repo's 30 source files**. Not academic.
 *
 * The rule is decided on the merits, not by the majority spelling. A trailing
 * comment after code is prose, and for a lock stated as "must be PRESENT" the
 * lenient spelling lets that prose satisfy the rule — which is a false PASS,
 * and the direction that matters, because these locks are mostly positive.
 *
 * The one exception is measured too: unguarded strict truncates a line at a
 * URL scheme, and `app/layout.tsx` has exactly such a line today. It is the
 * only file in the repo where guarded and unguarded strict differ.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ROOT,
  readRepoFiles,
  readSourceFiles,
  repoFiles,
  sourceFiles,
  stripComments,
} from "./support/source-files";

// The two spellings this replaced, kept here as the comparison the decision
// was made against. They are not exported from support/ on purpose: nothing
// should be able to reach for the lenient one again.
const LENIENT = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("stripComments — the rule", () => {
  it("strips a whole-line comment", () => {
    expect(stripComments("  // gone\nconst a = 1;\n").trim()).toBe("const a = 1;");
  });

  it("strips a trailing comment after code — the reason for the stricter rule", () => {
    // This is the false PASS the lenient spelling allowed. A lock asserting
    // `DEFAULT_BASE_DELAY_MS` is present was satisfied by prose mentioning it.
    const src = "const a = 1; // DEFAULT_BASE_DELAY_MS\n";
    expect(stripComments(src)).not.toContain("DEFAULT_BASE_DELAY_MS");
    expect(LENIENT(src), "the lenient spelling is what let prose through").toContain(
      "DEFAULT_BASE_DELAY_MS",
    );
  });

  it("strips a block comment", () => {
    expect(stripComments("/* gone */const a = 1;").trim()).toBe("const a = 1;");
  });

  it("preserves a URL scheme — the measured exception", () => {
    const src = 'const u = "https://example.com/x"; // note\n';
    expect(stripComments(src).trim()).toBe('const u = "https://example.com/x";');
  });

  it("preserves a URL inside JSX, the shape app/layout.tsx actually has", () => {
    const src = '<a className="underline" href="https://github.com/jt-mchorse/x">MIT</a>\n';
    expect(stripComments(src).trim()).toBe(src.trim());
  });

  it("leaves code untouched when there are no comments", () => {
    const src = "export function f(a: number) {\n  return a + 1;\n}\n";
    expect(stripComments(src)).toBe(src);
  });
});

describe("stripComments — the declared limits", () => {
  // Both are pinned as the KNOWN-WRONG answer plus a reachability assertion
  // over the real corpus, the same shape the repo uses elsewhere for a limit
  // it declines to model. A helper that pretends to lex is worse than one
  // whose limits are written down.

  it("truncates a protocol-relative URL (declared, and unreachable here)", () => {
    expect(stripComments('const u = "//cdn.example.com/x";').trim()).toBe('const u = "');

    const offenders = readSourceFiles()
      .filter(([, text]) =>
        text
          .split("\n")
          .some((line) => /(^|[^:/])\/\/[a-z0-9-]+\.[a-z]{2,}/i.test(line) && !/^\s*\/\//.test(line)),
      )
      .map(([rel]) => rel);
    expect(
      offenders,
      "a source file gained a protocol-relative URL; stripComments truncates the line " +
        "and this declared limit is now reachable",
    ).toEqual([]);
  });

  it('truncates a "//" inside an ordinary string (declared, and unreachable here)', () => {
    expect(stripComments('const s = "a // b"; const t = 1;').trim()).toBe('const s = "a');

    // A `//` preceded by a quote-and-text, i.e. inside a string literal rather
    // than after code. Deliberately narrow: this is a reachability probe, not
    // a lexer.
    const offenders = readSourceFiles()
      .filter(([, text]) => /["'`][^"'`\n]*[^:\s"'`][ \t]\/\/[^\n]*["'`]/.test(text))
      .map(([rel]) => rel);
    expect(
      offenders,
      'a source file gained a "//" inside a string literal; stripComments ' +
        "truncates it and this declared limit is now reachable",
    ).toEqual([]);
  });

  it("the reachability probes are not vacuous — they fire on a constructed offender", () => {
    // The assertions above are `toEqual([])` over a filter, which a filter that
    // matched nothing would also satisfy. Prove each pattern has teeth.
    const protoRel = (t: string): boolean =>
      t
        .split("\n")
        .some((line) => /(^|[^:/])\/\/[a-z0-9-]+\.[a-z]{2,}/i.test(line) && !/^\s*\/\//.test(line));
    expect(protoRel('const u = "//cdn.example.com/x";')).toBe(true);
    expect(protoRel('const u = "https://cdn.example.com/x";')).toBe(false);

    const inString = (t: string): boolean =>
      /["'`][^"'`\n]*[^:\s"'`][ \t]\/\/[^\n]*["'`]/.test(t);
    expect(inString('const s = "a // b";')).toBe(true);
    expect(inString("const a = 1; // b")).toBe(false);
  });
});

/**
 * The files allowed to call `readdirSync` themselves, each with the reason its
 * scope is genuinely not repo-wide. Measured, not guessed: the first spelling
 * of this list named `test/workflows-ci-timeout.test.ts`, which does not
 * exist, and the rot check below is what said so immediately.
 */
const EXEMPT_READDIR_FILES = [
  // Owns the walk.
  "test/support/source-files.ts",
  // GitHub does not read nested workflow files, so flat is the correct scope.
  "test/workflows-yaml-parseable.test.ts",
  "test/workflows-concurrency.test.ts",
  "test/workflows-timeout-minutes.test.ts",
  // `test/api-routes-accept-plain-request.test.ts` used to be here, with the
  // reason "private but already recursive, scoped to app/api". That reason was
  // TRUE and nothing enforced it: flatten the walk and the exemption's own
  // justification silently becomes false, which is the shape #122 fixed in the
  // shipped code. #126 removed the private walk instead of enforcing the claim,
  // so the entry is DELETED rather than reworded — and the rot check below is
  // what makes deleting it the cheaper option than keeping it honest.
] as const;

/**
 * Which real-world shapes the rejected spelling gets wrong (#126).
 *
 * `api-routes-accept-plain-request.test.ts` carried an inlined copy of `LENIENT`
 * and used it for a NEGATIVE source scan -- "no route mentions `.nextUrl`" --
 * over routes that deliberately document why they avoid it. Whole-line-only
 * stripping leaves a trailing note in the scanned text, so the lock rejected
 * correct routes. This is the comparison, here rather than there, because this
 * file is the only sanctioned place to write the lenient spelling down: drafting
 * it next to the scan made a SEVENTH copy, and the rule-literal arm below caught
 * it.
 */
describe("the lenient spelling rejects correct code in a negative source lock", () => {
  const SCAN = /\.nextUrl\b/;
  const ROUTES = [
    [
      "whole-line note (the shape every route uses today)",
      'export async function GET(req: Request) {\n' +
        '  // never req.nextUrl: undefined on a plain Request\n' +
        '  const u = new URL(req.url);\n}\n',
    ],
    [
      "trailing note on the line it describes",
      'export async function GET(req: Request) {\n' +
        '  const u = new URL(req.url); // not req.nextUrl - undefined on a plain Request\n}\n',
    ],
    [
      "trailing note after an import",
      'import { x } from "y"; // req.nextUrl is a NextRequest extension\n' +
        'export async function GET(req: Request) { return new Response(); }\n',
    ],
  ] as const;

  it("the shared rule passes every one of them", () => {
    for (const [label, src] of ROUTES) {
      expect(SCAN.test(stripComments(src)), `shared rule rejected: ${label}`).toBe(false);
    }
  });

  it("the lenient rule rejects exactly the two trailing-note shapes", () => {
    const rejected = ROUTES.filter(([, src]) => SCAN.test(LENIENT(src))).map(([l]) => l);
    expect(rejected).toEqual([
      "trailing note on the line it describes",
      "trailing note after an import",
    ]);
  });

  it("both rules still flag a route that really reads req.nextUrl", () => {
    // Anti-vacuous: the rows above must not be satisfied by a scan that never
    // matches. The two spellings differ on correct code and AGREE on the defect,
    // which is what makes the lenient one a false-failure machine rather than a
    // weaker check.
    const real = 'export async function GET(req) {\n  const u = req.nextUrl;\n}\n';
    expect(SCAN.test(stripComments(real))).toBe(true);
    expect(SCAN.test(LENIENT(real))).toBe(true);
  });
});

describe("structural: one definition, and no sixth private copy", () => {
  // `test/` only. Used by the one lock in this block whose claim really is
  // about test files — `no test file walks source with a private readdirSync`,
  // whose name, corpus and EXEMPT reasons all agree. The two locks whose names
  // say "the repo" use `readRepoFiles()` instead (#130).
  const testFiles = (): Array<readonly [string, string]> =>
    sourceFiles("test", ROOT).map(
      (rel) => [rel, readFileSync(join(ROOT, rel), "utf8")] as const,
    );

  it("finds the test files (anti-vacuous)", () => {
    const files = testFiles();
    expect(files.length, "the test-file walk found nothing").toBeGreaterThan(10);
    expect(files.map(([rel]) => rel)).toContain("test/support/source-files.ts");
  });

  // The claim these two locks make is "the repo". These arms pin the *corpus*,
  // not the result — a widened walk that quietly returned the same `test/` files
  // would satisfy every other arm in this block, because both rules are clean
  // over the non-test files today (#130).
  it("the repo walk reaches what the test walk and SOURCE_DIRS cannot", () => {
    const repo = repoFiles();
    const tests = sourceFiles("test", ROOT);
    const shipped = readSourceFiles().map(([rel]) => rel);

    expect(repo.length, "the repo walk found nothing").toBeGreaterThan(tests.length);
    // A strict superset of both populations it replaces.
    for (const rel of [...tests, ...shipped]) expect(repo).toContain(rel);

    // The five files in neither `test/` nor `SOURCE_DIRS`. This is the whole
    // point of widening to the repo rather than to the dirs SOURCE_DIRS names,
    // and the list is asserted rather than counted so a file leaving the repo
    // fails loudly instead of shrinking a number.
    const unreachableBefore = ["scripts/capture_demo.ts", "next.config.ts", "vitest.config.ts"];
    for (const rel of unreachableBefore) {
      expect(tests, `${rel} must not be in the test walk`).not.toContain(rel);
      expect(shipped, `${rel} must not be in SOURCE_DIRS`).not.toContain(rel);
      expect(repo, `${rel} must be in the repo walk`).toContain(rel);
    }
  });

  it("the repo walk keeps sourceFiles' exclusions", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-walk-"));
    try {
      mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(root, ".next", "cache"), { recursive: true });
      mkdirSync(join(root, "nested", "deep"), { recursive: true });
      writeFileSync(join(root, "node_modules", "pkg", "index.ts"), "export {};");
      writeFileSync(join(root, ".next", "cache", "gen.ts"), "export {};");
      writeFileSync(join(root, "top.ts"), "export {};");
      writeFileSync(join(root, "nested", "deep", "buried.tsx"), "export {};");
      writeFileSync(join(root, "notes.md"), "not source");

      // Root-level *and* arbitrarily deep, which is what "the repo" has to mean;
      // `node_modules` and dot-directories stay out.
      expect(repoFiles(root).sort()).toEqual(["nested/deep/buried.tsx", "top.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a stripComments outside test/ would be caught (anti-vacuous)", () => {
    // The defect the widened lock exists for, run against a synthetic tree
    // rather than asserted in prose. The real repo is clean, so without this
    // the widened lock is green for the same reason the narrow one was.
    const root = mkdtempSync(join(tmpdir(), "repo-decl-"));
    try {
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(
        join(root, "lib", "sneaky.ts"),
        'export function stripComments(s: string) {\n  return s;\n}\n',
      );
      const decls = readRepoFiles(root)
        .filter(([, text]) => /^\s*(export\s+)?function stripComments\b/m.test(stripComments(text)))
        .map(([rel]) => rel);
      expect(decls).toEqual(["lib/sneaky.ts"]);

      // ...and the narrow walk this replaced does not see it, which is the
      // whole finding.
      expect(sourceFiles("test", root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stripComments is defined exactly once in the repo", () => {
    // #123 exists because five copies accumulated with nothing watching. This
    // is what stops the sixth. Anchored at the start of a line, so neither an
    // `import { stripComments }` nor a *mention* of the name in a comment or a
    // regex literal is a hit — including the ones in this very file, which is
    // how the first spelling of this check failed against itself.
    // Over the REPO, which is what the name has always said. This walked
    // `test/` only until #130, so a `stripComments` in `lib/`, `components/`,
    // `app/`, `scripts/` or a root-level config left an exact-list assertion
    // green while reading as a complete census. Widening only to `SOURCE_DIRS`
    // would not have been enough either: that set reaches none of `test/`,
    // `scripts/`, or the five root-level files.
    const decls = readRepoFiles().filter(([, text]) =>
      /^\s*(export\s+)?function stripComments\b/m.test(stripComments(text)),
    );
    expect(
      decls.map(([rel]) => rel),
      "stripComments is declared in more than one place; import it from " +
        "test/support/source-files.ts instead",
    ).toEqual(["test/support/source-files.ts"]);
  });

  it("no test file walks source with a private readdirSync", () => {
    // The other half of #123. `support/source-files.ts` owns the walk; the
    // workflow locks are exempt because GitHub does not read nested workflow
    // files, which is a property of GitHub rather than a property of this repo
    // and so cannot quietly stop being true (#126).
    const EXEMPT = new Set<string>(EXEMPT_READDIR_FILES);
    // Over CODE, not raw text — and via the very helper this issue
    // consolidated, which is the neatest argument for having consolidated it.
    // Six files quote `readdirSync(...)` in a comment explaining a previous
    // migration, and the first spelling of this check flagged every one of
    // them. A grep over source cannot tell a call from prose about a call.
    const offenders = testFiles()
      .filter(([rel]) => !EXEMPT.has(rel))
      .filter(([, text]) => /\breaddirSync\s*\(/.test(stripComments(text)))
      .map(([rel]) => rel);
    expect(
      offenders,
      "a test file grew a private readdirSync over source; use sourceFiles() / " +
        "readSourceFiles() from test/support/source-files.ts, or add the file to " +
        "EXEMPT here with the reason its scope is not repo-wide",
    ).toEqual([]);
  });

  /**
   * The comment-stripping rule, as a regex literal, wherever it is written
   * down. Keyed on the RULE and not on the name `stripComments` (#126).
   *
   * The name-based arm above counts declarations of a function called
   * `stripComments`. The claim it stands in for is how many *implementations* of
   * the rule exist, and those are different units: the sixth copy #126 found was
   * an inlined `.replace(...).replace(...)` chain with no name at all, so
   * `/^\s*(export\s+)?function stripComments\b/m` returned false against the
   * file holding it. A lock keyed on a name cannot see an anonymous copy. Both
   * arms stay — a named copy and an inlined one are different shapes.
   */
  const LINE_COMMENT_STRIPPER = /\.replace\(\s*\/[^\n]*\\\/\\\/[^\n]*\/[a-z]*\s*,/;

  //: The only two files allowed to write the rule down, each for a reason that is
  //: a property of the file's PURPOSE rather than of its current contents:
  //:   - `support/source-files.ts` owns the definition;
  //:   - this file keeps the rejected `LENIENT` spelling as the comparison the
  //:     decision was made against, which is only meaningful written out.
  const RULE_DEFINING_FILES = [
    "test/support/source-files.ts",
    "test/strip-comments.test.ts",
  ] as const;

  /**
   * Drop whole-line comments only, by line position — NOT via `stripComments`.
   *
   * Deliberate, and the reason is #127: `stripComments` truncates a line whose
   * regex literal contains `\*\/` followed by a flag group, because the two
   * adjacent slashes read as a comment opener. It does that to its own
   * definition line and to 6 others, all of them exactly the lines this arm needs
   * to see. Using it here would make the scan below blind to the very literals it
   * is looking for — a stripper that eats the thing you are searching for is not
   * the right pre-filter for searching for it.
   *
   * A whole-line filter is enough here because the thing being excluded is prose
   * *about* the rule, and in these files that prose lives in JSDoc blocks and on
   * their own lines. Declared rather than modelled, same posture as the helper.
   */
  const codeLines = (text: string): string =>
    text
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

  it("the comment-stripping rule is written down in exactly two places", () => {
    const allowed = new Set<string>(RULE_DEFINING_FILES);
    // Repo-wide since #130, matching the name. Measured at the time: the rule
    // literal appears in none of the 35 non-test files, so widening costs no
    // false failure — and a copy landing in shipped source is the case worth
    // catching, not the one worth excusing.
    const offenders = readRepoFiles()
      .filter(([rel]) => !allowed.has(rel))
      .filter(([, text]) => LINE_COMMENT_STRIPPER.test(codeLines(text)))
      .map(([rel]) => rel);
    expect(
      offenders,
      "a test file wrote its own `//`-comment stripper; import `stripComments` " +
        "from test/support/source-files.ts instead. The lenient whole-line-only " +
        "spelling makes a NEGATIVE source lock reject correct code when the prose " +
        "it is explaining sits at the end of a line (#126).",
    ).toEqual([]);
  });

  it("the rule-literal matcher finds both shapes it exists for (anti-vacuous)", () => {
    // An inlined chain — the shape #126 found, which the name-based arm misses.
    const inlined =
      'const code = src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "").replace(/^\\s*\\/\\/.*$/gm, "");';
    expect(LINE_COMMENT_STRIPPER.test(inlined), "missed an inlined copy").toBe(true);
    // A named function — the shape the name-based arm catches. Both must hit.
    const named = 'function strip(s) { return s.replace(/(^|[^:])\\/\\/[^\\n]*/g, "$1"); }';
    expect(LINE_COMMENT_STRIPPER.test(named), "missed a named copy").toBe(true);
    // And it must not fire on an unrelated replace, or it is a tripwire that
    // makes every future `.replace` a review conversation.
    expect(LINE_COMMENT_STRIPPER.test('s.replace(/foo/g, "bar")')).toBe(false);
    expect(LINE_COMMENT_STRIPPER.test('s.replace(/^\\//, "")')).toBe(false);
  });

  it("both rule-defining files really do contain the rule", () => {
    // The positive half. Without it the arm above is green whenever the matcher
    // drifts, because it would simply find nothing anywhere.
    const byPath = new Map(testFiles());
    for (const rel of RULE_DEFINING_FILES) {
      const text = byPath.get(rel);
      expect(text, `${rel} not found by the test-file walk`).toBeDefined();
      expect(
        LINE_COMMENT_STRIPPER.test(codeLines(text as string)),
        `${rel} is on RULE_DEFINING_FILES but contains no stripper literal; the ` +
          "matcher has drifted and the arm above is vacuously green",
      ).toBe(true);
    }
  });

  it("the LENIENT fixture is only ever applied to inline literals", () => {
    // The exemption for this file is for a FIXTURE and must not become an
    // exemption for a scanner (#126). Checked on provenance, not on the argument's
    // NAME: a first spelling forbade `LENIENT(src)` and went red on the existing
    // call, where `src` is a local string literal — banning an identifier is a
    // proxy for banning a file read, and the proxy rejected correct code.
    //
    // So: every `LENIENT(x)` argument must be either a string literal or a local
    // `const` initialised from one.
    const self = readFileSync(join(ROOT, "test/strip-comments.test.ts"), "utf8");
    const code = codeLines(self);
    const literalConsts = new Set(
      [...code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]/g)].map((m) => m[1]),
    );
    const calls = [...code.matchAll(/\bLENIENT\(\s*([^),]+?)\s*[),]/g)].map((m) => m[1].trim());
    expect(calls.length, "LENIENT is unused; delete it or use it").toBeGreaterThan(0);
    const bad = calls.filter(
      (arg) => !/^["'`]/.test(arg) && !literalConsts.has(arg),
    );
    expect(
      bad,
      "LENIENT was applied to something other than an inline literal. It exists " +
        "only as the comparison the #123 decision was made against; applying it " +
        "to a file read off disk makes it a second rule (#126).",
    ).toEqual([]);
  });

  it("every EXEMPT entry still exists, so the allowlist cannot rot", () => {
    // An exemption naming a deleted file is an exemption nobody re-reads.
    const present = new Set(testFiles().map(([rel]) => rel));
    expect(EXEMPT_READDIR_FILES.filter((rel) => !present.has(rel))).toEqual([]);
  });
});
