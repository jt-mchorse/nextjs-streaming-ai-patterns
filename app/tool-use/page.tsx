import { ToolUseClient } from "@/components/tool-use-client";
import { SourcePane } from "@/components/source-pane";
import { getStreamMode } from "@/lib/anthropic-stream";

export const dynamic = "force-dynamic";

/**
 * /tool-use — the tool-use streaming pattern (#2).
 *
 * Top half: live demo. A Client Component reads `/api/tool-use` as an SSE
 * stream of typed events (`text_delta`, `tool_use_start`, `tool_use_delta`,
 * `tool_use_stop`, `tool_result`, `message_stop`) and renders each as a
 * step in the timeline. An interrupt button cancels the in-flight stream
 * via `AbortController` end-to-end (client → fetch → route handler →
 * mock generator) — see the [state machine doc][doc].
 *
 * Bottom half: source for the route handler + the client component.
 *
 * [doc]: ../../docs/tool-use-state-machine.md
 */
export default function ToolUsePage() {
  const mode = getStreamMode();

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Tool use</h1>
        <p className="max-w-2xl text-sm text-[var(--muted)]">
          The model streams a brief intro, calls a tool, sees the result,
          and continues. Each event renders as a card in the timeline; the
          interrupt button cancels the stream mid-flight via{" "}
          <code>AbortController</code> end-to-end. State machine documented
          in <code>docs/tool-use-state-machine.md</code>.
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
      <ToolUseClient />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--muted)]">Source</h2>
        <SourcePane
          files={[
            { label: "Route handler", path: "app/api/tool-use/route.ts", lang: "typescript" },
            { label: "Client component", path: "components/tool-use-client.tsx", lang: "tsx" },
            { label: "Mock streamer", path: "lib/mock-tool-stream.ts", lang: "typescript" },
          ]}
        />
      </section>
    </div>
  );
}
