/**
 * Public-surface tests for a Next.js app shape.
 *
 * Unlike a library (which has a single `src/index.ts` aggregator),
 * this repo's "public surface" is the union of:
 *
 * - `package.json#version` (TS analog of `__version__`).
 * - The `lib/*.ts` utility modules — consumed by Server Components,
 *   route handlers, and the live source viewer; they're committed
 *   source-of-truth that the UI reads from disk at request time.
 * - File paths quoted in README prose (especially the mermaid
 *   architecture diagram), which silently lie if the source moves.
 *
 * The existing `test/readme-patterns-table.test.ts` already locks the
 * PATTERNS table ↔ homepage entries ↔ `page.tsx` existence. This
 * test fills the orthogonal gaps without duplicating that one.
 *
 * Three axes, adapted from the portfolio-wide public-surface pattern
 * series (Python: nine strikes through `vector-search-at-scale#17`;
 * TS: first strike in `agent-orchestration-platform#19`). The agent
 * platform's `Object.keys(import * as Index)` axis is intentionally
 * NOT copied here — Next.js apps don't have a `src/index.ts` to
 * anchor the star-import. The axes below are adapted to what's
 * authoritative for this repo shape.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(__dirname, "..");
const LIB_DIR = resolve(ROOT, "lib");
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

// README's mermaid architecture diagram quotes these two file paths
// (lines 68 and 73 in README.md). If either moves or is renamed, the
// diagram silently lies — the source viewer keeps working with the
// new path but the README no longer matches reality.
const README_QUOTED_PATHS = [
  "lib/mock-stream.ts",
  "app/streaming-text/page.tsx",
] as const;

interface PackageJson {
  readonly version?: unknown;
}

function loadPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as PackageJson;
}

function listLibModules(): string[] {
  // Every `.ts` file directly under `lib/` is a public utility module
  // (no nested subdirs today). We list them at test time rather than
  // hard-coding the set so adding a new lib module doesn't silently
  // bypass this test.
  return readdirSync(LIB_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort();
}

describe("public surface — package.json#version", () => {
  it("is set to a semver-ish string", () => {
    const pkg = loadPackageJson();
    expect(pkg.version, "package.json#version is missing").toBeDefined();
    expect(
      typeof pkg.version,
      `package.json#version should be a string, got ${typeof pkg.version}`,
    ).toBe("string");
    const version = pkg.version as string;
    expect(version, "package.json#version is empty").not.toBe("");
    expect(
      SEMVER_PATTERN.test(version),
      `package.json#version = ${JSON.stringify(version)} doesn't look like semver`,
    ).toBe(true);
  });
});

describe("public surface — lib/*.ts modules", () => {
  const libModules = listLibModules();

  it("lib/ has at least one module file (sanity)", () => {
    expect(
      libModules.length,
      "lib/ is empty? Every utility module the pages consume should live here.",
    ).toBeGreaterThan(0);
  });

  // We dynamically import each lib file and check it has at least
  // one defined value export. Catches:
  //   - An accidental syntax / type-import-only file that ships no
  //     runtime value (Next.js builds may not fail on those).
  //   - A `tsx`/transpilation regression where a file imports
  //     unresolvable named exports from other modules.
  it.each(libModules)(
    "lib/%s imports cleanly and has at least one defined export",
    async (filename) => {
      const absPath = resolve(LIB_DIR, filename);
      const url = pathToFileURL(absPath).href;
      const mod = (await import(url)) as Record<string, unknown>;
      const exportNames = Object.keys(mod).filter((n) => n !== "default");
      const definedExports = exportNames.filter(
        (n) => mod[n] !== undefined && mod[n] !== null,
      );
      expect(
        definedExports.length,
        `lib/${filename} exports nothing defined at runtime. ` +
          `Object.keys(import) = ${JSON.stringify(exportNames)}. ` +
          "Either the module ships no runtime values (only types?) or a re-export silently broke.",
      ).toBeGreaterThan(0);
    },
  );
});

describe("public surface — README mermaid-diagram file paths", () => {
  it.each(README_QUOTED_PATHS)(
    "README quotes `%s` (mermaid diagram) — must exist on disk",
    (relPath) => {
      const absPath = resolve(ROOT, relPath);
      expect(
        existsSync(absPath),
        `README's mermaid architecture diagram quotes ${JSON.stringify(relPath)}, ` +
          "but that file does not exist. Either restore the source path " +
          "or update the diagram in README.md.",
      ).toBe(true);
    },
  );
});
