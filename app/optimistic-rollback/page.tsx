import { OptimisticRollbackClient } from "@/components/optimistic-rollback-client";
import { SourcePane } from "@/components/source-pane";

export const dynamic = "force-dynamic";

/**
 * /optimistic-rollback — React 19 useOptimistic + deterministic decision
 * oracle on the server. The demo lets a visitor reproducibly trigger both
 * the commit and the rollback paths; the source pane shows the actual
 * client + server + decision code read at request time (D-004).
 */
export default function OptimisticRollbackPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Optimistic updates with rollback
        </h1>
        <p className="max-w-2xl text-sm text-[var(--muted)]">
          React 19&apos;s <code>useOptimistic</code> renders the assumed next
          state immediately; the server route returns the LLM&apos;s real
          decision; the optimistic overlay drops when the transition resolves.
          On a rollback the overlay reverts naturally — the demo adds a
          one-second border flash + a rendered reason so the rollback is
          observable, not silent.
        </p>
        <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-xs text-[var(--muted)]">
          <span className="inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
          <span>deterministic 50/50 oracle — both branches reproducible</span>
        </div>
      </header>

      <div className="grid gap-8 md:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
            Live demo
          </h2>
          <OptimisticRollbackClient />
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-[var(--muted)]">
            Source
          </h2>
          <SourcePane
            files={[
              {
                label: "Client — useOptimistic + commit/rollback dispatch",
                path: "components/optimistic-rollback-client.tsx",
                lang: "tsx",
              },
              {
                label: "Server route — POST → deterministic Decision JSON",
                path: "app/api/optimistic/route.ts",
                lang: "typescript",
              },
              {
                label: "Decision oracle — deterministic 50/50, first click biased to success",
                path: "lib/optimistic-decision.ts",
                lang: "typescript",
              },
            ]}
          />
        </section>
      </div>
    </div>
  );
}
