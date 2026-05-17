import { PartialJsonClient } from "@/components/partial-json-client";
import { SourcePane } from "@/components/source-pane";
import { getStreamMode } from "@/lib/anthropic-stream";

export const dynamic = "force-dynamic";

/**
 * /partial-json — the partial-JSON parsing pattern (#3).
 *
 * Top half: live demo. The Client Component reads `/api/partial-json`
 * as an SSE stream of `json_delta` events, accumulates them into a
 * buffer, runs the in-repo `parsePartialJson` on every accumulated
 * snapshot, and re-renders the structured view with whichever fields
 * are currently parsable. Skeleton placeholders fill the not-yet-
 * parsed slots so the UI never jumps.
 *
 * Bottom half: source for the parser, mock streamer, route handler,
 * and client. The parser is the meat of the pattern — written
 * dep-free in-repo (D-008) so the technique is readable on the page
 * rather than hidden behind an npm package.
 */
export default function PartialJsonPage() {
  const mode = getStreamMode();

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Partial JSON parsing</h1>
        <p className="max-w-2xl text-sm text-[var(--muted)]">
          The model streams a structured response one chunk at a time. The UI
          parses on every chunk, dropping any half-typed key or value, and
          renders each field as soon as it is fully transmitted. Common
          patterns covered: open strings, open arrays/objects, trailing
          commas, mid-token primitives. Malformed input never throws an error.
        </p>
        <p className="text-xs text-[var(--muted)]">
          Mode: <code>{mode.mode}</code>
          {mode.model ? (
            <>
              {" "}
              · model <code>{mode.model}</code>
            </>
          ) : null}
        </p>
      </header>
      <PartialJsonClient />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--muted)]">Source</h2>
        <SourcePane
          files={[
            { label: "Partial-JSON parser", path: "lib/partial-json.ts", lang: "typescript" },
            { label: "Mock streamer", path: "lib/mock-json-stream.ts", lang: "typescript" },
            { label: "Route handler", path: "app/api/partial-json/route.ts", lang: "typescript" },
            { label: "Client component", path: "components/partial-json-client.tsx", lang: "tsx" },
          ]}
        />
      </section>
    </div>
  );
}
