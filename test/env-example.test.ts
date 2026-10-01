/**
 * `.env.example` lists exactly the app variables the code reads (#136).
 *
 * The file was complete when this landed, and nothing kept it that way. The
 * set is derived from source, so a new read fails here until it is listed,
 * and a listed variable nobody reads fails too. Comments are stripped first,
 * so prose that names a variable is not a read.
 *
 * The population and the comment rule are the shared ones in
 * `test/support/source-files.ts`, plus `scripts/`, which is not first-party
 * app source but is where `capture_demo.ts` reads its one variable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT, readSourceFiles, sourceFiles, stripComments } from "./support/source-files";

/**
 * Read by the code, but not app configuration:
 * - `CAPTURE_HEADED`: an environment alias for `scripts/capture_demo.ts`'s
 *   `--headed` flag, documented in that script's usage header.
 */
const NOT_APP_CONFIG = new Set(["CAPTURE_HEADED"]);

function envNamesRead(src: string): Set<string> {
  const code = stripComments(src);
  const names = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) names.add(m[1]);
  return names;
}

function namesReadByRepo(): Set<string> {
  const files: Array<readonly [string, string]> = [
    ...readSourceFiles(),
    ...sourceFiles("scripts").map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")] as const),
  ];
  const names = new Set<string>();
  for (const [, text] of files) for (const n of envNamesRead(text)) names.add(n);
  return names;
}

function namesListed(): Map<string, string> {
  const text = readFileSync(join(ROOT, ".env.example"), "utf8");
  return new Map([...text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2]]));
}

describe(".env.example (#136)", () => {
  it("reads both spellings and ignores a name that is only in a comment", () => {
    const slashes = "/".repeat(2);
    const src = [
      "/** configure with `process.env.IN_A_JSDOC` */",
      `${slashes} process.env.IN_A_LINE_COMMENT`,
      "const a = process.env.A_1;",
      'const b = process.env["B"];',
    ].join("\n");
    expect([...envNamesRead(src)].sort()).toEqual(["A_1", "B"]);
  });

  it("the scan finds the app reads and the excluded one", () => {
    // A floor, so a scope or walk regression cannot make the equality below
    // compare two empty sets. The exclusion is asserted present too: an
    // exclusion for a name nobody reads is a stale entry.
    const read = namesReadByRepo();
    for (const n of ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", ...NOT_APP_CONFIG]) {
      expect(read, n).toContain(n);
    }
  });

  it("lists exactly the app variables the code reads", () => {
    const read = [...namesReadByRepo()].filter((n) => !NOT_APP_CONFIG.has(n)).sort();
    expect([...namesListed().keys()].sort()).toEqual(read);
  });

  it("the key is blank, so a fresh clone runs on the mock streamer", () => {
    // The file's own comment: unset means every demo falls back to the
    // committed mock streamer. A placeholder here would be a key that fails.
    expect(namesListed().get("ANTHROPIC_API_KEY")).toBe("");
  });
});
