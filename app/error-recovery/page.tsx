import { ErrorRecoveryClient } from "@/components/error-recovery-client";
import { SourcePane } from "@/components/source-pane";

export const dynamic = "force-dynamic";

/**
 * /error-recovery — mid-stream drop + automatic resume from the last
 * server-side checkpoint. The route handler is deterministic: every
 * first request drops at a fixed token; every resume request streams
 * to completion. The client component records the most-recent
 * checkpoint, reconnects with it in the query string, and renders a
 * "resumed at token N" pill for ~2s so the recovery is observable.
 */
export default function ErrorRecoveryPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Error recovery mid-stream
        </h1>
        <p className="max-w-2xl text-sm text-[var(--muted)]">
          A real flaky upstream is hard to demo; a route handler that
          *always* drops the first request and *always* completes the
          resume is easy to demo. The protocol underneath is the
          interesting part: the server emits a checkpoint every five
          tokens carrying the most-recent token index, the client
          records it, and on disconnect the client reconnects with
          <code>?checkpoint=N</code>. The accumulating text never
          resets — chunks before the drop stay rendered, new chunks
          append in place, a small &ldquo;resumed&rdquo; pill blinks.
        </p>
        <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-xs text-[var(--muted)]">
          <span className="inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
          <span>deterministic drop after 12 tokens — recovery is reproducible</span>
        </div>
      </header>

      <div className="grid gap-8 md:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
            Live demo
          </h2>
          <ErrorRecoveryClient />
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
            Source
          </h2>
          <SourcePane
            files={[
              {
                label: "Client — SSE reader + checkpoint-driven reconnect",
                path: "components/error-recovery-client.tsx",
                lang: "tsx",
              },
              {
                label: "Server route — SSE with deterministic mid-stream drop",
                path: "app/api/error-recovery/route.ts",
                lang: "typescript",
              },
              {
                label: "Checkpoint generator — text + checkpoint events, drop after N",
                path: "lib/checkpoint-stream.ts",
                lang: "typescript",
              },
            ]}
          />
        </section>
      </div>
    </div>
  );
}
