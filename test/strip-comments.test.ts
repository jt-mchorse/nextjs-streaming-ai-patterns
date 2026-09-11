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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ROOT, readSourceFiles, sourceFiles, stripComments } from "./support/source-files";

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
  // Private but already recursive, scoped to app/api — the recursion is the
  // part that matters and it has it (#123).
  "test/api-routes-accept-plain-request.test.ts",
] as const;

describe("structural: one definition, and no sixth private copy", () => {
  const testFiles = (): Array<readonly [string, string]> => {
    const out: Array<readonly [string, string]> = [];
    for (const rel of sourceFiles("test", ROOT).concat(
      // `sourceFiles` filters to .ts/.tsx, which is what test files are.
      [],
    )) {
      out.push([rel, readFileSync(join(ROOT, rel), "utf8")]);
    }
    return out;
  };

  it("finds the test files (anti-vacuous)", () => {
    const files = testFiles();
    expect(files.length, "the test-file walk found nothing").toBeGreaterThan(10);
    expect(files.map(([rel]) => rel)).toContain("test/support/source-files.ts");
  });

  it("stripComments is defined exactly once in the repo", () => {
    // #123 exists because five copies accumulated with nothing watching. This
    // is what stops the sixth. Anchored at the start of a line, so neither an
    // `import { stripComments }` nor a *mention* of the name in a comment or a
    // regex literal is a hit — including the ones in this very file, which is
    // how the first spelling of this check failed against itself.
    const decls = testFiles().filter(([, text]) =>
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
    // files, and api-routes scopes itself to app/api with its own recursion.
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

  it("every EXEMPT entry still exists, so the allowlist cannot rot", () => {
    // An exemption naming a deleted file is an exemption nobody re-reads.
    const present = new Set(testFiles().map(([rel]) => rel));
    expect(EXEMPT_READDIR_FILES.filter((rel) => !present.has(rel))).toEqual([]);
  });
});
