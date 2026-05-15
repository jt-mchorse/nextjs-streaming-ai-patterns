import { createHighlighter, type Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Singleton highlighter. Boots once per server process; reused across requests.
 * Reused across multiple highlights so we don't pay the WASM boot for every
 * source-pane render.
 */
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: ["typescript", "tsx"],
    });
  }
  return highlighterPromise;
}

export async function highlight(code: string, lang: "typescript" | "tsx"): Promise<string> {
  const h = await getHighlighter();
  return h.codeToHtml(code, { lang, theme: "github-dark" });
}
