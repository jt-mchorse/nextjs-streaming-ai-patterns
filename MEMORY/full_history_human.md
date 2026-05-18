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


## 2026-05-17 — Issue #3: Partial JSON parsing and progressive rendering
**Duration:** ~60 min · **Branch:** `session/2026-05-17-1925-issue-03`

- Shipped `lib/partial-json.ts` (D-008) — a dep-free incremental JSON parser. Strategy: per-frame state machine (`expecting: 'key' | 'colon' | 'value' | 'comma_or_close'`, plus `committedAny` flag and `lastSafeEnd` boundary) walks the buffer once, tracks where each frame can be safely truncated, then closes open frames with the appropriate `]` / `}` to produce a valid JSON repair. The fast path (`JSON.parse` directly) wins when the buffer is already complete; otherwise the repaired prefix runs through `JSON.parse`. Returns `{ value, isComplete }` and never throws.
- `lib/mock-json-stream.ts` — emits the canned "trip itinerary" payload (top-level fields + `daily_plan[]` of 3 nested objects + budget) chunked on a pseudo-random 8-15-char schedule so the realistic mid-key, mid-value, and mid-array failure modes all surface in the demo. Uses the same SSE envelope shape every other pattern in this repo uses (D-006).
- `app/api/partial-json/route.ts` — SSE handler that propagates `req.signal` to the streamer for clean interrupt (D-007), same as #1/#2.
- `components/partial-json-client.tsx` — accumulates `json_delta` deltas into a buffer, runs `parsePartialJson` on each accumulation, renders a structured itinerary view where every field shows a skeleton placeholder until parsed. The skeleton-then-content swap means the UI never jumps; users see fields fill in progressively. Interrupt button is wired end-to-end.
- `app/partial-json/page.tsx` — same shape as `app/tool-use/page.tsx` (title, demo client, source pane reading disk per D-004 with parser, streamer, route, and client all shown).
- Homepage card for partial-json flipped from `pending` → `shipped`, issue 3 set.
- 23 new tests: 20 in `test/partial-json.test.ts` (happy-path complete-JSON, incomplete-object with trailing key/value/comma/literal-fragment, incomplete-array variants, nested structures with the half-typed last entry dropped, escaped quotes inside strings both open and closed, malformed-input never-throws fuzz, monotonic-improvement across an incremental sequence) + 3 in `test/mock-json-stream.test.ts` (deltas reconstruct the full payload, abort signal yields `stop_reason: "interrupted"`, the parser reaches `isComplete: true` on the final accumulated buffer). Suite total: 36/36 pass. Build, typecheck, lint all clean.

**Why this work, this session:** Issue #3 was the lowest-numbered open `priority:med` for this repo and the natural next pattern to ship — it's a foundational building block for the remaining two patterns (optimistic rollback can show optimistic JSON, error recovery needs partial state). The 60-min budget was enough for the parser to be honest (a ~120-line state machine with committedAny semantics rather than a quick regex-repair) plus the full demo wire-up. Writing the parser in-repo (D-008) keeps the demo page educational — the source pane shows exactly the technique a reader would otherwise have to reverse-engineer from a vendored library.

**Open questions / blockers:** None. Issues #4 (optimistic rollback) and #5 (error recovery) remain — both can land on top of `parsePartialJson` plus the existing route/client patterns.

**Next session:** Either #4 or #5 here, or move to ai-app-integration-tests / another repo per the multi-issue session rotation.

## 2026-05-18 — Issue #4: Optimistic updates with rollback
**Duration:** ~35 min · **Branch:** `session/2026-05-18-issue-04` · **PR:** #9

- Shipped the fifth pattern page (`/optimistic-rollback`): React 19 `useOptimistic` overlays `(improving…)` on the pending row; a server route POSTs `{id, click_count}` to a deterministic 50/50 oracle (`lib/optimistic-decision.ts`); the optimistic update commits or rolls back depending on the Decision. The rollback path runs a 900 ms pure-CSS `rollback-flash` keyframe with the LLM's refusal reason rendered under the item.
- The oracle is keyed by `(id, click_count)` with first-click bias to success, so the happy path leads and both branches are reproducible by construction. The property test pins the 50/50 split over 5 × 199 = 995 inputs (D-010).
- 17 new tests across two files (10 on the oracle, 7 on the route). Suite total 53 (was 36). Lint + typecheck + production build all clean; the home page's pattern catalog flips this entry from `pending` → `shipped`.

**Why this work, this session:** #4 was the lower-numbered of the two open med-priority issues in the repo and the natural fifth page in the catalog (the home page had already advertised it as pending). #5 (error recovery mid-stream) is the natural follow-on but didn't fit in the night session's remaining budget alongside other repos.

**Open questions / blockers:** PR body explicitly flags that the in-browser animation walkthrough was not performed on this branch — unit tests + a successful production build cover the logic, but the frame-by-frame animation needs a human reviewer's eyes. Surfacing this honestly rather than claiming a verification I didn't do.

**Next session:** ai-app-integration-tests #5 (CI suite under 5 minutes), then circle back to error-recovery mid-stream (#5 here) if time.
