import { StreamingTextClient } from "@/components/streaming-text-client";
import { SourcePane } from "@/components/source-pane";
import { getStreamMode } from "@/lib/anthropic-stream";

export const dynamic = "force-dynamic";

const PROMPT =
  "Write a short paragraph about why streaming output beats waiting for the whole message.";

/**
 * /streaming-text — the streaming text pattern.
 *
 * Top half: live demo. A Client Component reads /api/stream-text as an SSE
 * stream and renders tokens as they arrive in the browser.
 *
 * Bottom half: source code, read at request time from the actual files on
 * disk (D-004), syntax-highlighted server-side by shiki.
 *
 * On mobile the two halves stack vertically; on ≥md they're side-by-side.
 */
export default function StreamingTextPage() {
  const mode = getStreamMode();

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Streaming text</h1>
        <p className="max-w-2xl text-sm text-[var(--muted)]">
          A Next.js 15 route handler streams Anthropic&apos;s text deltas as Server-Sent
          Events. A small Client Component reads the stream via the Fetch API&apos;s
          ReadableStream and appends each delta. No WebSockets, no polling.
        </p>
        <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-xs text-[var(--muted)]">
          <span className="inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
          <span>
            {mode.mode === "live"
              ? `live: ${mode.model}`
              : "mock streamer (set ANTHROPIC_API_KEY to switch to live)"}
          </span>
        </div>
      </header>

      <div className="grid gap-8 md:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
            Live demo
          </h2>
          <StreamingTextClient prompt={PROMPT} />
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
            Source
          </h2>
          <SourcePane
            files={[
              {
                label: "Server route — streams Anthropic deltas as SSE",
                path: "app/api/stream-text/route.ts",
                lang: "typescript",
              },
              {
                label: "Client component — reads SSE, appends per chunk",
                path: "components/streaming-text-client.tsx",
                lang: "tsx",
              },
              {
                label: "Mode switch + Anthropic SDK call",
                path: "lib/anthropic-stream.ts",
                lang: "typescript",
              },
            ]}
          />
        </section>
      </div>
    </div>
  );
}
