/**
 * The page copy renders as the words it was written as (#165).
 *
 * `/error-recovery`'s intro paragraph showed visitors two things its source did
 * not mean:
 *
 * - `*always*` -- markdown emphasis typed into JSX text, which React prints
 *   verbatim, asterisks and all;
 * - `reconnects with?checkpoint=N` -- the line ended in a word and the next
 *   began with `<code>`, and JSX drops whitespace that contains a newline at
 *   the edge of a text node. `/tool-use` writes `{" "}` there for exactly this
 *   reason; this page did not.
 *
 * Both are invisible in the source and obvious on the page, and no test
 * rendered page copy, so this one does: every pattern page plus the homepage,
 * server-rendered with React's own renderer. The demo clients and the source
 * panes are stubbed out -- they are tested elsewhere, and the source pane
 * reads and highlights whole files whose comments legitimately contain both
 * shapes.
 */
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `next/link`'s default export does not survive the node test transform's
// interop; the homepage only needs it to render an anchor around each card.
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: (props: { href: string; className?: string; children?: unknown }) =>
      h("a", { href: props.href, className: props.className }, props.children as never),
  };
});
vi.mock("@/components/source-pane", () => ({ SourcePane: () => null }));
vi.mock("@/components/streaming-text-client", () => ({ StreamingTextClient: () => null }));
vi.mock("@/components/tool-use-client", () => ({ ToolUseClient: () => null }));
vi.mock("@/components/partial-json-client", () => ({ PartialJsonClient: () => null }));
vi.mock("@/components/optimistic-rollback-client", () => ({
  OptimisticRollbackClient: () => null,
}));
vi.mock("@/components/error-recovery-client", () => ({ ErrorRecoveryClient: () => null }));

import HomePage from "../app/page";
import ErrorRecoveryPage from "../app/error-recovery/page";
import OptimisticRollbackPage from "../app/optimistic-rollback/page";
import PartialJsonPage from "../app/partial-json/page";
import StreamingTextPage from "../app/streaming-text/page";
import ToolUsePage from "../app/tool-use/page";

const PAGES = {
  "/": HomePage,
  "/streaming-text": StreamingTextPage,
  "/tool-use": ToolUsePage,
  "/partial-json": PartialJsonPage,
  "/optimistic-rollback": OptimisticRollbackPage,
  "/error-recovery": ErrorRecoveryPage,
} as const;

beforeAll(() => {
  // The test transform compiles JSX to a bare `React.createElement` (and `<>`
  // to `React.Fragment`).
  vi.stubGlobal("React", { createElement, Fragment });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

function render(route: keyof typeof PAGES): string {
  return renderToStaticMarkup(createElement(PAGES[route]));
}

/** Inline elements that sit inside a sentence. */
const INLINE = "(?:code|em|strong|a)";

/** A word character directly against an inline element's edge. */
const GLUED = new RegExp(`\\w<${INLINE}\\b|</${INLINE}>\\w`);

/** Markdown emphasis that reached the page as literal characters. */
const MARKDOWN_EMPHASIS = /(?:^|[\s>(])(\*{1,2}|_{1,2})\w[^<*_]*?\w\1(?=[\s<.,;:!?)]|$)/;

describe("page copy renders as written (#165)", () => {
  it.each(Object.keys(PAGES) as Array<keyof typeof PAGES>)(
    "%s renders copy",
    (route) => {
      // Anti-vacuity: a stub that swallowed the page would pass both checks
      // below on an empty string.
      expect(render(route).length).toBeGreaterThan(200);
    },
  );

  it.each(Object.keys(PAGES) as Array<keyof typeof PAGES>)(
    "%s has no literal markdown emphasis",
    (route) => {
      expect(render(route)).not.toMatch(MARKDOWN_EMPHASIS);
    },
  );

  it.each(Object.keys(PAGES) as Array<keyof typeof PAGES>)(
    "%s has no word glued to an inline element",
    (route) => {
      const html = render(route);
      const hit = GLUED.exec(html);
      expect(hit ? html.slice(Math.max(0, hit.index - 60), hit.index + 60) : null).toBeNull();
    },
  );

  it("the error-recovery intro reads as a sentence", () => {
    const html = render("/error-recovery");
    expect(html).toContain("a route handler that <em>always</em> drops the first request");
    expect(html).toContain("reconnects with <code>?checkpoint=N</code>.");
  });

  it("the checks see the shapes they exist for", () => {
    // The two patterns, against the exact text main rendered.
    expect("a route handler that *always* drops").toMatch(MARKDOWN_EMPHASIS);
    expect("reconnects with<code>?checkpoint=N</code>").toMatch(GLUED);
    // ...and not against correct copy or ordinary identifiers.
    expect("via <code>AbortController</code> end-to-end").not.toMatch(GLUED);
    expect("React 19's <code>useOptimistic</code> renders").not.toMatch(GLUED);
    expect("ANTHROPIC_API_KEY and trip_length_days").not.toMatch(MARKDOWN_EMPHASIS);
  });
});
