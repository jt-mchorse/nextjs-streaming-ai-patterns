# Session History (human-readable)

Chronological log of work sessions. Most recent first below the divider.

---

## 2026-05-15 — Issue #1: streaming text pattern
**Duration:** ~75 min · **Branch:** `session/2026-05-15-1055-issue-01`

- Scaffolded the Next.js 15 + React 19 + Tailwind v4 app (one app at repo root, one page per pattern). Hub page at `/` lists shipped + pending patterns.
- Shipped `app/streaming-text/page.tsx` — server-rendered shell with a Client Component that reads `/api/stream-text` as Server-Sent Events and progressively renders tokens. End-to-end verified by booting `npm run dev` and curling the SSE endpoint (real per-token framing).
- Built a no-key fallback (`lib/mock-stream.ts` + `lib/anthropic-stream.ts`): when `ANTHROPIC_API_KEY` is unset, the demo runs against a deterministic mock streamer with realistic per-token jitter. Mode is surfaced in the page UI.
- Built a `<SourcePane />` Server Component that reads source files from disk at request time and syntax-highlights them with shiki. The displayed source can't drift from the actual code.
- 7 hermetic vitest tests on the mock streamer (deterministic-given-seed, fixture round-trip, near-zero wall-clock when seeded).
- CI: `npm ci → lint → typecheck → test → build` in one job.
- Backfilled README and `docs/architecture.md` with the pattern catalog, the request-flow diagram, and the rationale for picking route-handler-SSE over pure-RSC streaming.
- Locked four cookbook decisions (D-002 layout, D-003 no-key fallback, D-004 source-from-disk, D-005 SSE-not-RSC).

**Why this work, this session:** Issue #1 is the foundation pattern; every future stream pattern (#2 tool-use, plus the unfiled partial-JSON / optimistic / error-recovery) reuses the SSE+reader shape locked here. Locking the four decisions now prevents re-litigating them per pattern.

**Open questions / blockers:** None. `npm audit` reports 7 moderate severity advisories from transitive dev-deps; not blocking for a patterns-repo example, will revisit if a real exploit lands.

**Next session:** Issue #2 (tool-use UI with interruption) — extend the same SSE format with `event: tool_use` frames; add an Abort button on the client side.

## 2026-05-16 — Issue #2: Tool-use UI with interruption
**Duration:** ~45 min · **Branch:** `session/2026-05-16-0503-issue-2`

- Shipped the tool-use streaming pattern as the second page in this repo, `/tool-use`. `lib/mock-tool-stream.ts` emits the canonical Anthropic-shaped tool-use sequence (text_delta → tool_use_start → tool_use_delta+ → tool_use_stop → tool_result → text_delta+ → message_stop). The mock is deterministic-given-seed and honors an `AbortSignal` at every yield boundary so the interrupt path produces a clean partial transcript.
- `app/api/tool-use/route.ts` adapts the streamer to SSE using the same wire format the text pattern uses (D-006 — one protocol for all streaming patterns). Each event becomes `event: <type>\ndata: <json>\n\n`. The route propagates `req.signal` to the streamer so client aborts close the upstream cleanly.
- `components/tool-use-client.tsx` is the timeline UI: a small state machine (idle → connecting → streaming_text → tool_called → tool_running → tool_completed → streaming_text → done | interrupted | error) walked as events arrive. Each event becomes a card; the tool card renders streaming JSON args with a cursor while incomplete and pretty-prints the parsed object once `tool_use_stop` arrives. The "Interrupt" button calls `AbortController.abort()` (D-007).
- `docs/tool-use-state-machine.md` documents all 9 states and transitions explicitly + spells out the three-layer abort propagation (client → route handler → streamer). The doc exists so a regression in the renderer shows up as a diff against the table, not as an off-by-one in implicit branching.
- 6 new tests in `test/mock-tool-stream.test.ts` covering the canonical event sequence + ordering invariants, JSON-args concatenation produces valid JSON, tool_use_id consistency across start/result, determinism given seed, and two interrupt paths (immediate abort, mid-stream abort). Suite total: 13/13 pass; lint + typecheck clean; `next build` produces the new `/tool-use` and `/api/tool-use` routes.
- Homepage's pattern list flips tool-use from `pending` to `shipped`.

**Why this work, this session:** #2 was the last open priority:high in nextjs-streaming-ai-patterns. With it shipped, the repo demonstrates two of its five planned streaming patterns end-to-end, which is enough to back the "Next.js streaming AI patterns" claim in the README.

**Open questions / blockers:** None. The remaining three patterns (partial-JSON parsing, optimistic-rollback, error-recovery) are filed as priority:med follow-ups (or will be once the issue tracker is reviewed).

**Next session:** All v0.1-critical work is shipped; the remaining issue tracker is priority:med polish.
