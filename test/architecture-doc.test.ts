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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

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

// ---------------------------------------------------------------------------
// Symbol-resolution lock (portfolio-ops #55, TS side — nextjs #76).
//
// The four invariants above lock path tokens, PATTERNS-slug coverage, active
// decisions, and banned phrases — but nothing checks that the *symbols* the
// doc names actually exist in the code. A doc that renamed `streamText` ->
// `streamTokens`, or `validatePrompt` -> `guardPrompt`, would sail through CI
// green. That's the exact drift class portfolio-ops #55 catalogued portfolio-
// wide (e.g. llm-cost-optimizer's nonexistent `BatchAPIBackend`,
// embedding-model-shootout's `compute_frontier`).
//
// The Python siblings (llm-eval-harness #140, rag-production-kit #118,
// chunking-strategies-lab #104, ...) resolve doc symbols against the package
// via importlib/`hasattr`. TS has no importlib analogue at test time, so the
// ground truth here is a static scan of every *top-level declaration* across
// `lib/`, `components/`, and `app/` -- exported OR internal. Internal is
// load-bearing: `validatePrompt` and `validateOptions` are non-exported guards
// the doc names by name, so an export-only surface would false-positive on
// both (the same lesson as llm-cost-optimizer #122's "submodule-aware, not
// surface-only" note, where `UnknownModelError` wasn't in `__all__`).
//
// Candidate selection mirrors the Python adaptation: only *multi-word*
// camelCase/PascalCase backticked identifiers are checked. Single lowercase
// words (`value`, `mock`, `live`), SCREAMING_CASE env/const tokens
// (`ANTHROPIC_API_KEY`, `DEFAULT_MODEL`), and snake_case JSON/event tokens
// (`text_delta`, `tool_use_*`) are deliberately excluded -- they're prose and
// wire-format noise, not repo symbols, and checking them would either
// false-positive or force an unmaintainable allow-list. Two hard-pinned
// exception sets carry the rest: `EXTERNAL_SYMBOLS` (framework/web/SDK) and
// `DOC_FIELDS` (return-object fields the doc names that aren't module symbols).

const SOURCE_DIRS = ["lib", "components", "app"] as const;
const SOURCE_EXTS = [".ts", ".tsx"] as const;

// Framework / web / SDK identifiers the doc names in backticks that are NOT
// repo declarations. Multi-word only (single-word Pascal like `Anthropic` /
// `Suspense` never enters the candidate set). Hard-pinned below so adding a new
// external is a conscious widening, not an accidental one.
const EXTERNAL_SYMBOLS: ReadonlyArray<string> = [
  "ReadableStream", // web streams API (client incremental read)
  "useOptimistic", // React 19 hook (optimistic-rollback pattern)
] as const;

// Return-object / result field names the doc legitimately references that are
// object properties, not top-level module declarations. `isComplete` is a
// field of `PartialJsonResult` (lib/partial-json.ts), surfaced in the doc's
// partial-json narrative. Kept as an explicit, verified pin rather than
// broadening the ground truth to all property keys (which would weaken the
// lock into "identifier appears anywhere in source").
const DOC_FIELDS: ReadonlyArray<string> = ["isComplete"] as const;

/** Strip fenced code blocks (``` ... ```), including the mermaid diagram, so
 *  the backtick pairing for inline-code extraction can't desync on the triple
 *  fences. Symbols that only appear inside diagrams/trees are intentionally out
 *  of scope; the doc's prose is the contract. */
function stripFences(md: string): string {
  return md.replace(/```[\s\S]*?```/g, "");
}

/** True for a multi-word camelCase or PascalCase identifier -- one with an
 *  internal lower->upper boundary (`streamText`, `getStreamMode`) or a
 *  Pascal-with-second-cap shape (`ReadableStream`). Single-word tokens of any
 *  case return false. */
function isMultiWordIdentifier(tok: string): boolean {
  return /[a-z][A-Z]/.test(tok) || /[A-Z][a-z].*[A-Z]/.test(tok);
}

/** Extract multi-word camel/Pascal identifier candidates from the doc: fenced
 *  blocks stripped, then every inline-code span split into identifier tokens
 *  (dotted member refs split on `.` so `Anthropic.messages.stream` yields its
 *  parts). Returns a sorted unique list. */
function candidateSymbols(md: string): string[] {
  const prose = stripFences(md);
  const out = new Set<string>();
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    for (const piece of m[1].split(/[^A-Za-z0-9_$]+/)) {
      for (const tok of piece.split(".")) {
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tok) && isMultiWordIdentifier(tok)) {
          out.add(tok);
        }
      }
    }
  }
  return [...out].sort();
}

/** Recursively collect `*.ts` / `*.tsx` files under a directory. */
function sourceFiles(dir: string): string[] {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(abs, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(join(dir, entry.name)));
    else if (SOURCE_EXTS.some((e) => entry.name.endsWith(e))) files.push(full);
  }
  return files;
}

/** Every top-level declaration name across the source dirs -- exported or
 *  internal. Matches `function`/`function*`, `const`/`let`/`var`, `class`,
 *  `type`, `interface`, `enum`, with optional `export` / `export default` /
 *  `async` prefixes. This is the TS analogue of the Python resolver's module
 *  attribute surface. */
function repoDeclaredSymbols(): Set<string> {
  const decl =
    /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(?:function\*?|const|let|var|class|type|interface|enum)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const names = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(dir)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(decl)) names.add(m[1]);
    }
  }
  return names;
}

/** The shared resolution path used by BOTH the live doc test and the inverse
 *  drift test -- so the inverse test exercises the real resolver, not a
 *  re-implementation, and a resolver that silently resolves everything can't go
 *  vacuously green. Returns the candidates that resolve to nothing. */
function unresolvedSymbols(md: string, repoSymbols: Set<string>): string[] {
  const allowed = new Set<string>([...EXTERNAL_SYMBOLS, ...DOC_FIELDS]);
  return candidateSymbols(md).filter(
    (sym) => !repoSymbols.has(sym) && !allowed.has(sym),
  );
}

describe("docs/architecture.md names only symbols that exist (#76 / portfolio-ops #55)", () => {
  const md = readFileSync(ARCH_PATH, "utf8");
  const repoSymbols = repoDeclaredSymbols();

  it("extracts a non-empty candidate set (guards regex/extraction breakage)", () => {
    // If the extraction silently yields nothing (a broken regex, a doc rewrite
    // that drops all inline code), the resolution test below would pass
    // vacuously. Pin a floor.
    expect(candidateSymbols(md).length).toBeGreaterThan(0);
  });

  it("discovers the repo's real declarations as ground truth", () => {
    // Sanity floor on the source scan: these four are named in the doc's prose
    // and known to exist (two exported, two internal). If the scan regresses to
    // empty/tiny, the resolution test would false-flag everything -- catch it
    // here with a specific, legible message instead.
    for (const known of ["streamText", "getStreamMode", "validatePrompt", "validateOptions"]) {
      expect(repoSymbols.has(known), `expected repo declaration '${known}' in the source scan`).toBe(true);
    }
  });

  it("every multi-word symbol the doc names resolves to a declaration or a pinned exception", () => {
    const unresolved = unresolvedSymbols(md, repoSymbols);
    expect(
      unresolved,
      `docs/architecture.md names these multi-word identifiers that resolve to no ` +
        `top-level declaration in lib/ components/ app/, and are not in EXTERNAL_SYMBOLS ` +
        `or DOC_FIELDS: ${JSON.stringify(unresolved)}. Either fix the doc, or (if the ` +
        `symbol is a genuine framework API / object field) add it to the matching pinned set.`,
    ).toEqual([]);
  });

  it("flags an injected drifted symbol while a real one in the same text resolves (inverse safety net)", () => {
    // Prove the resolver actually rejects a nonexistent symbol -- otherwise the
    // green above could be vacuous. `streamTextXYZ` is not a declaration, not
    // external, not a field; `streamText` is a real export. Same code path as
    // the live test.
    const injected = "the real `streamText` sits next to a drifted `streamTextXYZ` here";
    const unresolved = unresolvedSymbols(injected, repoSymbols);
    expect(unresolved).toContain("streamTextXYZ");
    expect(unresolved).not.toContain("streamText");
  });

  it("EXTERNAL_SYMBOLS is the exact pinned set", () => {
    // Hard-pin so a future loose edit widening the external allow-list is a
    // conscious, reviewed change.
    expect([...EXTERNAL_SYMBOLS]).toEqual(["ReadableStream", "useOptimistic"]);
  });

  it("DOC_FIELDS is the exact pinned set", () => {
    expect([...DOC_FIELDS]).toEqual(["isComplete"]);
  });

  it("SOURCE_DIRS is the exact pinned set", () => {
    // The ground-truth scan roots. Widening (a new top-level code dir) should be
    // an intentional edit, not silent drift.
    expect([...SOURCE_DIRS]).toEqual(["lib", "components", "app"]);
  });
});
