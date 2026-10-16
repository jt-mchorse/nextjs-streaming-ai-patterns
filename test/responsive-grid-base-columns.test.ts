/**
 * A grid that sets its columns at a breakpoint also sets them below it (#185).
 *
 * `/streaming-text`, `/optimistic-rollback` and `/error-recovery` wrapped the
 * demo and the source in `grid gap-8 md:grid-cols-2`. At a 390px viewport the
 * pages were 951, 1933 and 1245px wide. `md:grid-cols-2` is
 * `repeat(2, minmax(0, 1fr))`, and the `0` minimum is what lets a column be
 * narrower than its content. Below `md` there was no `grid-cols-*` at all, so
 * the grid had one implicit `auto` track. That track grows to the min-content
 * width of its widest item, here the shiki `<pre>` and its longest source line.
 * The `<pre>`'s `overflow-x: auto` never took effect, because its container
 * was never narrower than it.
 *
 * The rule: a class list that sets `grid-cols-*` behind a variant prefix
 * (`md:`, `lg:`, `min-[…]:`) also sets an unprefixed `grid-cols-*`. The
 * population is every string literal in shipped source, not a list of page
 * names, so a new two-pane page or a `cn(...)` argument is covered. The
 * rendered arm reads the class attributes React actually emits, so a class
 * list assembled at runtime cannot get past the source scan.
 *
 * Out of scope, measured rather than assumed: `components/partial-json-client.tsx`
 * has two grids that switch at no breakpoint. Their cells hold the committed
 * mock's prose, which wraps, and `/partial-json` measures 390px at a 390px
 * viewport both before and after this change.
 */
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { readSourceFiles, stripComments } from "./support/source-files";

vi.mock("@/components/source-pane", () => ({ SourcePane: () => null }));
vi.mock("@/components/streaming-text-client", () => ({ StreamingTextClient: () => null }));
vi.mock("@/components/tool-use-client", () => ({ ToolUseClient: () => null }));
vi.mock("@/components/partial-json-client", () => ({ PartialJsonClient: () => null }));
vi.mock("@/components/optimistic-rollback-client", () => ({
  OptimisticRollbackClient: () => null,
}));
vi.mock("@/components/error-recovery-client", () => ({ ErrorRecoveryClient: () => null }));

import ErrorRecoveryPage from "../app/error-recovery/page";
import OptimisticRollbackPage from "../app/optimistic-rollback/page";
import HomePage from "../app/page";
import PartialJsonPage from "../app/partial-json/page";
import StreamingTextPage from "../app/streaming-text/page";
import ToolUsePage from "../app/tool-use/page";

const BASE_COLS = /^grid-cols-/;
const VARIANT_COLS = /^\S+:grid-cols-/;

/** The responsive `grid-cols-*` tokens in a class list that has no base one. */
function missingBaseColumns(classList: string): string[] {
  const tokens = classList.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => BASE_COLS.test(t))) return [];
  return tokens.filter((t) => VARIANT_COLS.test(t));
}

const STRING_LITERAL = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;

/** Every class list in shipped source that sets columns at a breakpoint. */
function responsiveGridClassLists(): Array<{ file: string; classList: string }> {
  const out: Array<{ file: string; classList: string }> = [];
  for (const [file, src] of readSourceFiles()) {
    for (const m of stripComments(src).matchAll(STRING_LITERAL)) {
      const classList = m[1] ?? m[2] ?? m[3] ?? "";
      if (classList.split(/\s+/).some((t) => VARIANT_COLS.test(t))) {
        out.push({ file, classList });
      }
    }
  }
  return out;
}

describe("missingBaseColumns", () => {
  it.each([
    ["grid gap-8 md:grid-cols-2", ["md:grid-cols-2"]],
    ["grid gap-4 lg:grid-cols-3 md:grid-cols-2", ["lg:grid-cols-3", "md:grid-cols-2"]],
    ["grid min-[480px]:grid-cols-2", ["min-[480px]:grid-cols-2"]],
    ["grid grid-cols-1 gap-8 md:grid-cols-2", []],
    ["grid md:grid-cols-2 grid-cols-1", []],
    ["grid grid-cols-[6rem_1fr] gap-2", []],
    ["grid gap-1", []],
    ["flex md:flex-row", []],
  ] as const)("%s", (classList, missing) => {
    expect(missingBaseColumns(classList)).toEqual(missing);
  });
});

describe("every responsive grid in shipped source has base columns (#185)", () => {
  const found = responsiveGridClassLists();

  it("finds the three two-pane pages and the homepage card grid", () => {
    // Anti-vacuity: the scan has to reach the grids the issue measured.
    const files = new Set(found.map((f) => f.file));
    for (const file of [
      "app/page.tsx",
      "app/streaming-text/page.tsx",
      "app/optimistic-rollback/page.tsx",
      "app/error-recovery/page.tsx",
    ]) {
      expect(files, file).toContain(file);
    }
  });

  it("no class list leaves the columns below its breakpoint implicit", () => {
    const offenders = found
      .filter((f) => missingBaseColumns(f.classList).length > 0)
      .map((f) => `${f.file}: "${f.classList}"`);
    expect(offenders).toEqual([]);
  });
});

describe("the rendered pages emit base columns with every responsive grid (#185)", () => {
  beforeAll(() => {
    vi.stubGlobal("React", { createElement, Fragment });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const PAGES = [
    ["/", HomePage],
    ["/streaming-text", StreamingTextPage],
    ["/tool-use", ToolUsePage],
    ["/partial-json", PartialJsonPage],
    ["/optimistic-rollback", OptimisticRollbackPage],
    ["/error-recovery", ErrorRecoveryPage],
  ] as const;

  it.each(PAGES)("%s", (route, Page) => {
    const html = renderToStaticMarkup(createElement(Page));
    const classLists = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
    const responsive = classLists.filter((c) => c.split(/\s+/).some((t) => VARIANT_COLS.test(t)));
    const offenders = responsive.filter((c) => missingBaseColumns(c).length > 0);
    expect(offenders, route).toEqual([]);
  });

  it("the two-pane pages and the homepage each render a responsive grid", () => {
    // Anti-vacuity for the arm above: a page whose grid was moved into a
    // mocked component would render no responsive class list and pass.
    for (const [route, Page] of PAGES) {
      if (route === "/tool-use" || route === "/partial-json") continue;
      const html = renderToStaticMarkup(createElement(Page));
      expect(html, route).toMatch(/class="[^"]*\bmd:grid-cols-2\b/);
    }
  });
});
