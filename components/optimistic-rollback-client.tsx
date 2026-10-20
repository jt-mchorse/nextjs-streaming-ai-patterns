"use client";

import { useOptimistic, useState, useTransition } from "react";

import { DEMO_NAMES } from "@/lib/optimistic-decision";

type ItemStatus = "idle" | "rolled-back";

interface Item {
  readonly id: string;
  readonly name: string;
  /** Per-item click counter, incremented on every submit. */
  readonly clicks: number;
  /** Last refusal reason (when the most-recent attempt rolled back). */
  readonly lastReason: string | null;
  readonly status: ItemStatus;
}

interface OptimisticItem extends Item {
  readonly pending: boolean;
}

function initialItems(): Item[] {
  return DEMO_NAMES.map((id) => ({
    id,
    name: id,
    clicks: 0,
    lastReason: null,
    status: "idle",
  }));
}

/**
 * Optimistic-rollback pattern demo.
 *
 * Each item carries a name. Clicking "Improve" optimistically replaces
 * the name with "Improving…" via React 19's useOptimistic; the server
 * route /api/optimistic returns a deterministic decide() result. On
 * success the new name commits via setItems. On failure the optimistic
 * update naturally reverts (useOptimistic clears its overlay once the
 * transition resolves), and we set `status: "rolled-back"` so the UI
 * can run a brief shake animation with the refusal reason.
 *
 * Why useOptimistic and not just setItems-twice? Because the optimistic
 * "Improving…" state lasts only as long as the in-flight request — when
 * the response lands, useOptimistic's overlay is discarded and the
 * committed state from setItems takes over. There's no manual "did we
 * apply this yet?" bookkeeping; the React 19 hook is exactly the
 * primitive this pattern wants.
 */
export function OptimisticRollbackClient() {
  const [items, setItems] = useState<Item[]>(initialItems);
  const [optimisticItems, addOptimistic] = useOptimistic<
    OptimisticItem[],
    string
  >(
    items.map((i) => ({ ...i, pending: false })),
    (state, idToMark) =>
      state.map((it) =>
        it.id === idToMark
          ? { ...it, pending: true, name: `${it.name} (improving…)` }
          : it,
      ),
  );
  const [isPending, startTransition] = useTransition();

  const onImprove = (id: string) => {
    startTransition(async () => {
      addOptimistic(id);
      // Bump click count first so the seed used for `decide` matches
      // the number of times this item has been clicked (1-indexed).
      const item = items.find((i) => i.id === id);
      const nextClicks = (item?.clicks ?? 0) + 1;
      let payload: Awaited<ReturnType<typeof callApi>>;
      try {
        // The committed name, so a success never "improves" it to itself (#154).
        payload = await callApi(id, nextClicks, item?.name ?? id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setItems((prev) =>
          prev.map((it) =>
            it.id === id
              ? {
                  ...it,
                  clicks: nextClicks,
                  lastReason: `network error: ${message}`,
                  status: "rolled-back",
                }
              : it,
          ),
        );
        return;
      }

      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== id) return it;
          if (payload.ok) {
            return {
              ...it,
              name: payload.improved_name,
              clicks: nextClicks,
              lastReason: null,
              status: "idle",
            };
          }
          return {
            ...it,
            // name stays the same — the rollback is the absence of update.
            clicks: nextClicks,
            lastReason: payload.reason,
            status: "rolled-back",
          };
        }),
      );
    });
  };

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {optimisticItems.map((it) => {
          const rolledBack = it.status === "rolled-back" && !it.pending;
          return (
            <li
              key={it.id}
              className={[
                "flex items-center justify-between gap-3 rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 transition-all",
                it.pending ? "opacity-70" : "",
                rolledBack ? "animate-rollback border-red-500/50" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-testid={`item-${it.id}`}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-mono">{it.name}</span>
                {rolledBack && it.lastReason ? (
                  <span className="mt-0.5 text-xs text-red-400">
                    rolled back · {it.lastReason}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => onImprove(it.id)}
                disabled={it.pending || isPending}
                className="rounded border border-[var(--border)] px-3 py-1 text-xs font-medium uppercase tracking-wide text-[var(--muted)] transition-colors hover:bg-[var(--border)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {it.pending ? "improving…" : "improve"}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-[var(--muted)]">
        First click on each item commits a new name (happy path). Subsequent
        clicks split 50/50 — successes commit, failures roll back with the
        reason rendered above and a brief border-flash animation. The split
        is deterministic per (id, click count) so the rollback path is
        reproducible from the demo.
      </p>
    </div>
  );
}

/** Shown when a 200 reply is not a decision the client can read (#197). */
const MALFORMED_RESPONSE = "malformed response";

async function callApi(
  id: string,
  click_count: number,
  current_name: string,
): Promise<
  | { ok: true; improved_name: string }
  | { ok: false; reason: string }
> {
  const res = await fetch("/api/optimistic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, click_count, current_name }),
  });
  // A non-OK status is named by its status, as the other four clients do. This
  // ran `res.json()` unconditionally, so a 5xx page threw and the catch in
  // onImprove showed "network error: <JS parser message>" (#197). Only a
  // `fetch` that rejects -- or a body read that does -- is a network error.
  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, reason: MALFORMED_RESPONSE };
  }
  // Valid JSON is not necessarily a decision: `null` threw on `.ok`, and
  // `{ok: true}` with no name rolled back as "unknown error" (#197).
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const d = body as { ok?: unknown; improved_name?: unknown; reason?: unknown };
    if (d.ok === true && typeof d.improved_name === "string") {
      return { ok: true, improved_name: d.improved_name };
    }
    if (d.ok === false && typeof d.reason === "string") {
      return { ok: false, reason: d.reason };
    }
  }
  return { ok: false, reason: MALFORMED_RESPONSE };
}
