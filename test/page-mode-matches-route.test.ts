/**
 * A page's "Mode:" header describes what its route actually streams (#169).
 *
 * `getStreamMode()` reports whether ANTHROPIC_API_KEY is set. `/tool-use` and
 * `/partial-json` rendered it, so with a key set they said "Mode: live · model
 * claude-haiku-4-5", while `/api/tool-use` and `/api/partial-json` only ever
 * stream the committed mocks. D-003 makes the mode visible in the UI; showing
 * the wrong one is worse than showing none.
 *
 * Two checks. Structural: every page that imports `getStreamMode` is backed by
 * a route that imports the live streamer. The population is discovered: the
 * page's client component is read for the `/api/<name>` it fetches. Rendered:
 * with a key set, the two mock-only pages say "mock" and never "live".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ROOT, sourceFiles } from "./support/source-files";

vi.mock("@/components/source-pane", () => ({ SourcePane: () => null }));
vi.mock("@/components/tool-use-client", () => ({ ToolUseClient: () => null }));
vi.mock("@/components/partial-json-client", () => ({ PartialJsonClient: () => null }));
vi.mock("@/components/optimistic-rollback-client", () => ({
  OptimisticRollbackClient: () => null,
}));
vi.mock("@/components/error-recovery-client", () => ({ ErrorRecoveryClient: () => null }));

import ErrorRecoveryPage from "../app/error-recovery/page";
import OptimisticRollbackPage from "../app/optimistic-rollback/page";
import PartialJsonPage from "../app/partial-json/page";
import ToolUsePage from "../app/tool-use/page";

const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

const IMPORTS_MODE = /import\s*\{[^}]*\bgetStreamMode\b[^}]*\}\s*from\s*"@\/lib\/anthropic-stream"/;
const IMPORTS_LIVE_STREAMER = /import\s*\{[^}]*\bstreamText\b[^}]*\}\s*from\s*"@\/lib\/anthropic-stream"/;

/** The `/api/<name>` routes a page's client components fetch. */
function routesFetchedBy(pageSrc: string): string[] {
  const out = new Set<string>();
  for (const m of pageSrc.matchAll(/from\s*"@\/components\/([\w-]+)"/g)) {
    const file = `components/${m[1]}.tsx`;
    if (!existsSync(join(ROOT, file))) continue;
    for (const f of read(file).matchAll(/fetch\(\s*[`"']\/api\/([\w-]+)/g)) out.add(f[1]);
  }
  return [...out];
}

const PAGES = sourceFiles("app")
  .map((rel) => /^app\/([\w-]+)\/page\.tsx$/.exec(rel)?.[1])
  .filter((name): name is string => name !== undefined);

describe("a page shows the stream mode only if its route has a live path (#169)", () => {
  it("discovers the pattern pages and the routes they fetch", () => {
    // Anti-vacuity: five pattern pages, each fetching at least one route.
    expect(PAGES.length).toBeGreaterThanOrEqual(5);
    for (const page of PAGES) {
      expect(routesFetchedBy(read(`app/${page}/page.tsx`)), page).not.toHaveLength(0);
    }
  });

  it.each(PAGES)("/%s", (page) => {
    const src = read(`app/${page}/page.tsx`);
    if (!IMPORTS_MODE.test(src)) return;
    for (const route of routesFetchedBy(src)) {
      expect(
        read(`app/api/${route}/route.ts`),
        `/${page} renders getStreamMode(), but /api/${route} has no live path`,
      ).toMatch(IMPORTS_LIVE_STREAMER);
    }
  });
});

describe("every page whose routes have no live path says mock (#171)", () => {
  // #169's lock above only reaches pages that render `getStreamMode()`. A page
  // that shows no mode at all passed it, and two of the four mock-only pages
  // were that page. The population here is the routes, not the import.
  const MOCK_ONLY = PAGES.filter((page) =>
    routesFetchedBy(read(`app/${page}/page.tsx`)).every(
      (route) => !IMPORTS_LIVE_STREAMER.test(read(`app/api/${route}/route.ts`)),
    ),
  );

  it("finds the four mock-only pages and leaves /streaming-text out", () => {
    expect(MOCK_ONLY).toEqual(
      expect.arrayContaining(["tool-use", "partial-json", "optimistic-rollback", "error-recovery"]),
    );
    expect(MOCK_ONLY).not.toContain("streaming-text");
  });

  it.each(PAGES)("/%s", (page) => {
    if (!MOCK_ONLY.includes(page)) return;
    expect(read(`app/${page}/page.tsx`), `/${page} streams only mocks and must say so`).toContain(
      'data-stream-mode="mock"',
    );
  });

  it("README's Quickstart names every mock-only page (#177)", () => {
    // The README paragraph that says what the key switches listed #169's two
    // mock-only pages after #171 found four. #172 updated architecture.md and
    // the headers but not this enumeration, so it is checked against the same
    // derived population as the headers above.
    const readme = read("README.md");
    const start = readme.indexOf("Without `ANTHROPIC_API_KEY`");
    expect(start, "Quickstart's no-key paragraph not found").toBeGreaterThan(-1);
    const para = readme.slice(start, readme.indexOf("\n\n", start));
    const missing = MOCK_ONLY.filter((page) => !para.includes(`\`/${page}\``));
    expect(missing, "mock-only pages the Quickstart does not name").toEqual([]);
    for (const page of PAGES.filter((p) => !MOCK_ONLY.includes(p))) {
      expect(para, `/${page} has a live path`).toMatch(new RegExp(`\`/${page}\` to live`));
    }
  });
});

describe("the mock-only pages say mock with a key set (#169)", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeAll(() => {
    vi.stubGlobal("React", { createElement, Fragment });
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-169";
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it.each([
    ["/tool-use", ToolUsePage],
    ["/partial-json", PartialJsonPage],
    ["/optimistic-rollback", OptimisticRollbackPage],
    ["/error-recovery", ErrorRecoveryPage],
  ] as const)("%s", (_route, Page) => {
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain('data-stream-mode="mock"');
    expect(html).not.toMatch(/\blive\b/);
  });

  it("/optimistic-rollback attributes no decision to an LLM (#171)", () => {
    // `/api/optimistic` hashes (id, click count); the header said "the server
    // route returns the LLM's real decision".
    const html = renderToStaticMarkup(createElement(OptimisticRollbackPage));
    expect(html).toContain("deterministic oracle");
    expect(html).not.toMatch(/\bLLM\b/);
  });
});
