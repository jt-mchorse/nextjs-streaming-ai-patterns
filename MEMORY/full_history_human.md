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

## 2026-05-18 — Issue #5: Error recovery mid-stream
**Duration:** ~35 min · **Branch:** `session/2026-05-18-issue-05` (stacked on PR #9) · **PR:** #10

- Shipped the sixth and final pattern page (`/error-recovery`). The protocol: server emits a `checkpoint` event every 5 tokens carrying the index of the most-recent text token (D-011 — integer index, not opaque cursor); client records it; on disconnect the client reconnects with `?checkpoint=N` and the server resumes by skipping the first N tokens. The route handler is deterministic: the first request always drops after 12 text tokens; every resume request streams cleanly to `event: done`.
- The client accumulates text *without resetting* on drops — chunks before the drop stay rendered while the reconnect fires, then new chunks append in place. A `resumed at token N` pill renders for 2s after each reconnect; a `N recoveries` counter chip stays until done; a phase dot transitions idle → streaming → recovering → streaming → done.
- 13 new tests (9 on the checkpoint generator, 4 on the route handler). Suite total 66 (was 53). Lint + typecheck + production build all clean.
- The home page's pattern catalog flips this entry from `pending` → `shipped`. All five originally-pending patterns are now built.

**Why this work, this session:** With #4 (optimistic-rollback) shipped earlier in the night and this entry the natural follow-on, knocking out both lets the repo cross "all five patterns shipped" inside one night. The two PRs touch adjacent entries in `app/page.tsx`, so the PR body explicitly flags the stacking + rebase order to make review easy.

**Open questions / blockers:** As with #4, in-browser walkthrough not performed inside this PR — unit tests + production build cover the logic, but the resumed-pill timing + cursor-through-reconnect feel needs a human reviewer's eye. Surfacing this honestly rather than claiming a verification I didn't do.

**Next session:** All med-priority issues in this repo are now closed. Loop continues against other repos or the low-priority backlog.

## 2026-05-18 — Issue #11: README truth pass — all five patterns shipped

**Duration:** ~35 min · **Branch:** `session/2026-05-18-2311-issue-11`

- Repaired a real drift in the README. Five patterns are shipped (closed issues #1–#5, every page lives under `app/<slug>/page.tsx`, homepage `PATTERNS` array describes all five correctly), but the README still framed only streaming-text as shipped and the Demo section claimed a 60s capture was "pending until at least three patterns ship". Both stale. Rewrote the Patterns table so rows 2–5 read `shipped` with issue refs, rewrote "What this is" to describe the full set (one bullet per pattern + the SSE-envelope contract and AbortController threading that tie them together), and rewrote Demo to be honest about today's state (live demo via `npm run dev`; captured GIF still pending, now tracked in follow-up #12).
- Added `test/readme-patterns-table.test.ts` (3 tests). Parses both the README's Patterns table and `app/page.tsx`'s `PATTERNS` array and asserts they match row-for-row (title, slug, status, issue number) plus every README-referenced `app/<slug>/page.tsx` exists on disk. Same hygiene pattern as today's snapshot tests across the portfolio (`llm-cost-optimizer`, `prompt-regression-suite`, `rag-production-kit`). Verified the failure path by flipping streaming-text's status to `pending` — test fired with the expected/received diff; reverted.
- 66 → 69 tests. `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` all clean. Curl-smoked every pattern page (200 OK on `/` plus the five slugs) and the deterministic SSE routes (`/api/error-recovery` emits checkpoint frames on cue) on a fresh dev server.

**Why this work, this session:** A repo whose README disagrees with its own homepage and its own closed-issue history is the failure mode this portfolio's `phase:shipped` posture is supposed to prevent. With the homepage already correct, the README was a 35-min concrete fix that also extends today's portfolio-wide snapshot-test pattern to the front-end repo.

**Open questions / blockers:** Captured 60s demo asset still doesn't exist — explicitly handed off as #12 (priority:low, low-effort follow-up with screen-capture tooling) rather than silently leaving the gap.

**Next session:** Loop into another repo's gaps. This repo's open-issue board now contains only #12 (low) — substantive feature work for this repo is done.

## 2026-05-20 — Issue #14: lock public surface (TS variant for Next.js app)
**Duration:** ~25 min · **Branch:** `session/2026-05-20-0347-issue-14`

- Added `test/public-surface.test.ts` (vitest, 3 test definitions → 12 test items after `it.each` over 8 `lib/*.ts` modules and 2 README-quoted file paths). Adapted from the `agent-orchestration-platform#19` TS template for a Next.js app shape: no `src/index.ts` aggregator, no `package.json#bin`. Three axes: `package.json#version` semver, every `lib/*.ts` imports cleanly with at least one defined value export (dynamically imported via `pathToFileURL`), README's mermaid-diagram-quoted file paths (`lib/mock-stream.ts`, `app/streaming-text/page.tsx`) exist on disk.
- `lib/*.ts` modules are listed at test time via `readdirSync` so adding a new module auto-onboards into the test (no hard-coded set to drift).
- Tamper-verified three axes: bad `package.json#version`, rename `lib/mock-stream.ts` (fires README-path test), empty `lib/shiki.ts` (fires parametrized lib-module test with "exports nothing defined at runtime").
- Full suite 81/81 (was 69; +12 new), typecheck + lint clean.

**Why this work, this session:** Eleventh strike of the portfolio-wide public-surface hygiene pattern, second TS variant. Orthogonal to the existing `test/readme-patterns-table.test.ts` (PATTERNS ↔ homepage ↔ page.tsx); this PR fills the gaps that test doesn't cover.

**Open questions / blockers:** None — PR ready for review.

**Next session:** Apply this TS-Next.js variant (or the agent-orchestration TS-library variant) to `ai-app-integration-tests`, the last pure-TS portfolio repo without the pattern.

## 2026-05-21 — Issue #12: 60-second demo capture (script + smoke test; binary deferred to #16)
**Duration:** ~35 min · **Branch:** `session/2026-05-21-2311-issue-12` · **PR:** to be opened

- Added `scripts/capture_demo.ts` — a Playwright-driven deterministic 60-second tour of the homepage and the five pattern pages, with per-page interactions where the pattern needs them (Run+Interrupt on `/tool-use`, two clicks on the first item of `/optimistic-rollback` to fire D-010's deterministic 50/50 rollback, auto-start everywhere else). Hermetic by design: no API key, mock-mode pill (D-003) visible by default in every page header.
- Added `test/capture-demo-smoke.test.ts` (6 tests) — imports the `TIMELINE` constant from the capture script and asserts: starts on `/`, the other 5 slugs match `app/page.tsx`'s `PATTERNS` array, every referenced `page.tsx` exists on disk, no duplicate stops, every stop has a non-empty label and a `durationMs ≥ holdMs`, total duration in [30s, 90s]. Mirrors the drift-prevention shape of `test/readme-patterns-table.test.ts`. Tamper-verified: changing `/tool-use` to `/toy-use` fires two assertions; reverted clean.
- Added `playwright.config.ts` (minimal; `outputDir: ./docs`, `video: 'on'`, 1280x720 viewport, deviceScaleFactor 2) as the canonical viewport shape; the capture script's `newContext({...})` mirrors it.
- Added `playwright`, `@playwright/test`, and `tsx` as devDeps. Critically: `playwright` does NOT auto-install browsers on `npm install` (postinstall hook was removed years ago), so CI stays fast and the ~150 MB browser install is explicit (`npx playwright install chromium`) — only the recording engineer pays that cost. The vitest smoke test never launches a browser.
- README "Demo" section: replaced the `pending #12` placeholder paragraph with the `npm run capture` walkthrough plus an explanation of the tour stops, the mock-mode pill, and the split to #16 for the binary commit.
- Filed follow-up #16 — "run the script, ffmpeg-optimize the output, commit `docs/demo.{webm,mp4,gif}`, embed in README." Estimated 30 min, ridden by D-012.
- New decision **D-012** — capture-via-deterministic-script-binary-deferred-to-followup. Mirrors what landed across the five sister repos today. Full suite 87/87, typecheck + lint clean.

**Why this work, this session:** Sixth and final repo today to land the `scripts/capture_demo.*` pattern. Closes the script-side of the only "demo" gap on this repo's six-item quality bar. The repo's PR was the last `priority:low` open item; with this it can join the 36+-hour rotation as a "fully built, no engineering open" repo.

**Open questions / blockers:** None for the engineering. #16 is a 30-min operational task gated on local Playwright browsers + ffmpeg.

**Next session:** Pick the next stale repo per Phase A selection rules. `ai-app-integration-tests` is now the only one 36+ hours untouched.

## 2026-05-22 — docs/architecture.md showed only streaming-text shipped while four other patterns had already landed (#18)

**Duration:** ~30 min. **Issue:** [#18](https://github.com/jt-mchorse/nextjs-streaming-ai-patterns/issues/18). **PR:** [#19](https://github.com/jt-mchorse/nextjs-streaming-ai-patterns/pull/19).

`docs/architecture.md` was first committed when only the streaming-text pattern had shipped, and the doc was never reframed when patterns #2 (tool-use), #3 (partial-json), #4 (optimistic-rollback), and #5 (error-recovery) landed. The directory diagram listed only one pattern page (`streaming-text/page.tsx ← shipped (issue #1)`), one API route, and "7 hermetic tests (vitest)" — even though `app/` now contains five pattern pages, five API routes, six client components, eight lib helpers, and the suite is 87 tests across 11 files. The "Pending patterns (open / to-be-filed issues)" section three quarters of the way down listed tool-use as `#2 (pending)` and the other three as `*(unfiled)*`, but `gh issue view 2/3/4/5 --state any` all return CLOSED. The README's Patterns table (locked by the existing `readme-patterns-table.test.ts`) already showed all five as `shipped`; only the architecture doc lagged.

README L103 also carried a stale `npm test  # 7 hermetic tests on the mock streamer` comment — `npm test` runs the whole vitest suite, not just the mock-streamer file. Replaced with a count-free phrasing that explains the no-key posture instead.

Rewrote the directory diagram to enumerate all five pattern pages, all five API route directories, all six client components, all eight lib helpers (annotated with their D-NNN decisions), and the capture-demo script. Replaced "7 hermetic tests" with a glob marker that doesn't rot. Replaced the "Pending patterns" section with a "Shipped patterns" section naming each pattern's load-bearing decision (D-007/D-008/D-010/D-011) and surface, with the capture-demo follow-on (#16) noted at the end.

Lock-against-drift: `test/architecture-doc.test.ts` (vitest, parallel shape to the existing `readme-patterns-table.test.ts`). Three invariants — every `app/<slug>/` token in the doc resolves to a real directory; every `PATTERNS` slug in `app/page.tsx` is referenced at least once in the doc; absence of `(unfiled)`, `to-be-filed`, `Pending patterns` (case-insensitive). A fourth `it()` hard-pins the banned set itself so a loose edit can't silently drop one. Tamper-verified by reintroducing the stale section: 4 of the 6 new tests fired (the three banned-phrase tests plus the PATTERNS-slug coverage test).

Same exact shape as `mcp-server-cookbook` #22 (PR #23) shipped earlier this session — an architecture doc that froze at the first pattern's PR and was never reframed. Fourth drift fix of this session; twelfth in the portfolio pattern. Open questions / blockers: none.

## 2026-05-23 — Architecture-doc active-decision-range axis + D-002 backfill (#20)

**Duration:** ~20 min. **Issue:** [#20](https://github.com/jt-mchorse/nextjs-streaming-ai-patterns/issues/20). **PR:** [#21](https://github.com/jt-mchorse/nextjs-streaming-ai-patterns/pull/21).

Ninth of twelve repos to ship the active-decision-range upper-bound axis on its architecture-doc lock; first TypeScript sister to land it through this loop (after `agent-orchestration-platform` which already had it). Ported the Python pattern (the regex-driven `active_decisions` fixture from `llm-eval-harness` PR #32) to TypeScript as a pair of helpers — `activeDecisions(decisionsText)` returns numeric ids, `referencedDecisions(md)` returns a `Set<number>`. Caught real drift on first run: D-002 (one Next.js app at the repo root, one page per pattern) was the load-bearing scope decision for the entire app layout but was uncited in the doc. Backfilled inline at the intro paragraph. Tamper-verified three axes.

**Why this work, this session:** Fifth issue in today's multi-issue loop. The TypeScript port adds a new portable shape to the portfolio's hygiene-pattern toolkit.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Apply same TypeScript pattern to `ai-app-integration-tests` and `mcp-server-cookbook`.

## 2026-05-24 — Issue #22: `mockTextStream` honors `AbortSignal` for cancellation parity

**Duration:** ~10 min. **Issue:** [#22](https://github.com/jt-mchorse/nextjs-streaming-ai-patterns/issues/22). **Branch:** `session/2026-05-24-1545-issue-22`.

`mockTextStream` was the only mock stream in `lib/` without an `options.signal` AbortSignal. `mockToolStream` and `mockJsonStream` already accept and honor it — a consumer wiring `/api/stream-text` to an Interrupt button had no way to cancel mid-stream. Aborting the AbortController on the client side closed the HTTP connection, but the server-side generator kept walking the fixture, racing the GC.

`MockStreamOptions` gains `signal?: AbortSignal`. `mockTextStream` checks `signal?.aborted` between tokens and returns cleanly. The setTimeout-based inter-token delay now uses the same signal-aware sleep shape as `mock-tool-stream.ts` (timer resolves on either fire or abort), so an interrupt mid-pause unblocks the loop immediately rather than waiting out the current token's delay. Unlike tool/json streams, the text-stream event shape is just `{ text: string }` — there is no "interrupted" marker to yield. Returning is the correct semantic; the route layer's SSE `done` event is what the client sees.

Three new tests in a dedicated describe block: pre-aborted signal yields zero tokens; aborted-after-first-yield stops cleanly within one extra token; no-signal regression-pin so the refactor doesn't break the existing fixture-emit path.

**Why this work, this session:** Seventh Phase B+C target of a 180-min day session, after `llm-eval-harness` #37, `prompt-regression-suite` #32, `mcp-server-cookbook` #31, `embedding-model-shootout` #26, `python-async-llm-pipelines` #29, and `agent-orchestration-platform` #28. First TS frontend target of the day; same pattern as the day's earlier work — close a parity gap where a previously-shipped capability didn't reach a sibling surface.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Continue the day-session loop if time permits. Remaining repos: `ai-app-integration-tests` (TS frontend, untouched today), `rag-production-kit` / `chunking-strategies-lab` / `vector-search-at-scale` (already touched in Phase A this morning).

## 2026-05-25 — Issue #24: streamCheckpoints validateOptions blocks degenerate StreamOptions at entry
**Duration:** ~25 min · **Branch:** `session/2026-05-24-issue-24`

- `streamCheckpoints` at `lib/checkpoint-stream.ts:81` accepted `StreamOptions` without runtime validation. The most concrete harm: `dropAfter = 0` silently fires the drop on the *first* text event (`emittedThisRun = 1 >= 0` is satisfied at `:115`), contradicting the field docstring "after this many additional text tokens are emitted" and the "at least one chunk before the connection dies" comment. Operator likely meant `undefined` (no drop) but got "immediate drop". The mid-stream-drop pattern (#5) is load-bearing UX for the error-recovery demo — a silent immediate drop on misconfig is worse than a loud config error because the visitor attributes the failure to the pattern, not to the config.
- Additional silent gaps: `startAfter < 0` devolves to `0` (no skip); `NaN` for either field devolves to `undefined`-defaults; fractional `startAfter` cuts off at `floor(startAfter)` — surprising and violates D-011's "checkpoints are integer indices" posture.
- Added `validateOptions(options)` at the top of `streamCheckpoints`, before any yield. `startAfter` (when defined) must be integer `>= 0`; `dropAfter` (when defined) must be integer `>= 1`. Each invalid field throws `RangeError` naming the field and value.
- 12 new tests in `test/checkpoint-stream.test.ts` under an issue-`#24` `describe` block: `it.each` over per-field bad-value tables (zero where invalid, negative, fractional, NaN, +Infinity); boundary acceptance at `startAfter = 0` and `dropAfter = 1`; one "validation runs before any yield" pin that calls `gen.next()` and expects rejection — so the entry-site contract can't drift into the loop. File 21/21 (was 9). Full suite 111/111 (was 99). Typecheck + ESLint clean.

**Why this work, this session:** Fourth Phase B+C target in the 360-min night session. Third TypeScript repo to ship the contract-tightening sweep pattern after `agent-orchestration-platform` #29 and `mcp-server-cookbook` #32. The TS validation pattern now lives in three repos; the Python `__post_init__` pattern in seven.

**Open questions / blockers:** none — PR ready for review.

**Next session:** Continue the loop. `ai-app-integration-tests` (build seq #12) is the last unvisited-tonight repo. After that, the loop can deepen on already-touched repos for more contract-tightening or pivot to other harm classes.

## 2026-05-26 — Issue #26: Three mock streamer validators close the #24 deferral
**Duration:** ~30 min · **Branch:** `session/2026-05-26-0010-issue-26`

- `mockTextStream` (`lib/mock-stream.ts`), `mockToolStream` (`lib/mock-tool-stream.ts`), and `mockJsonStream` (`lib/mock-json-stream.ts`) all consumed `baseDelayMs` and `jitterMs` from their options without validation while `streamCheckpoints` was tightened in #24. The prior session's memory explicitly deferred this work as "mock_streams_unvalidated_deferred"; this PR closes the deferral.
- Closed four silent failure modes (per file, identical shape): `baseDelayMs=NaN` made `setTimeout(_, NaN)` coerce to 0 — every token dumped on the next tick, streaming UX silently broken in the demo path; `baseDelayMs=Infinity` clamped to setTimeout's max delay (~24-50 days), first sleep hung effectively forever, demo appeared to deadlock; `baseDelayMs=-5` was absorbed by `sleep`'s `if (ms <= 0) return` early-out (the prior memory labeled this "harmless"; tightening makes the contract explicit); `jitterMs=Infinity` propagated through `Math.floor(rand() * Infinity) = Infinity` → combined delay Infinity → same hang.
- Each streamer now calls `validateOptions(options)` as its first statement, before `??` default reading or any yield. Contract: `Number.isFinite(v) + v >= 0` (not `>= 1` — zero is a meaningful "no per-token delay" config for fast tests; fractional ms accepted because the docstring says "ms" not "integer ms" and `setTimeout` truncates anyway). Error message uses the per-type prefix so callers can grep to the specific surface.
- Three `validateOptions` helpers live next to their respective generators (duplicated by design — a shared `lib/_validate.ts` would couple three independent demo patterns through a fourth module; the symmetry is intentional and the duplication is small).
- 79 new collected test cases across three symmetric describe blocks. `mockToolStream` and `mockJsonStream` sleep unconditionally (no `seed-skips-sleep` bypass like `mockTextStream`), so their acceptance tests use `gen.next()` + `gen.return()` rather than full collection — that's enough to exercise the validator without burning a 60s test budget. Full suite 111 → 190. Typecheck clean.

**Why this work, this session:** Eighth Phase B+C target in the 360-min night session and fourth TypeScript Phase B+C PR (after `agent-orchestration-platform#32` and `mcp-server-cookbook#35`). Picked via build-sequence #11. The #24 PR's explicit deferral note in memory was the source-of-truth pointer that made this issue file itself.

**Open questions / blockers:** none — PR ready for review.

**Next session:** `ai-app-integration-tests` (build #12, the last repo) is the natural close-the-loop pickup. After that, the portfolio's validation-sweep arc will have touched every repo this night session.

## 2026-05-26 — Issue #28: README decision-range upper-bound lock
**Duration:** ~6 min · **Branch:** `session/2026-05-26-2339-issue-28`

- Added `test/readme-decision-range.test.ts`.
- Added `D-002…D-012` citation under `## Architecture`.

**Why this work, this session:** Propagation 10 of 10 of the cross-portfolio drift class. Portfolio now at 11 of 12 repos covered.

**Open questions / blockers:** none.
**Next session:** ai-app-integration-tests is the last gap.

## 2026-05-27 — Issue #30: CONTRIBUTING.md cadence-wording propagation
**Duration:** ~3 min · **PR:** #31

- Replaced pre-D-008 `~60-minute session cap` line with D-008 (180/360 min, multi-issue loop) and D-004 (Phase A PR auto-merge) wording, matching the bootstrap template post-portfolio-ops#3.

**Why this work, this session:** Iteration in the autonomous NIGHT session propagation arc for portfolio-ops#3.

**Open questions / blockers:** none.

**Next session:** continue portfolio propagation.

## 2026-06-02 — Issue #32: validatePrompt + getStreamMode env hardening
**Duration:** ~20 min · **Branch:** `session/2026-06-02-0336-issue-32`

- Added `validatePrompt(prompt)` at the top of `streamText` in `lib/anthropic-stream.ts`. `TypeError` for non-string, `RangeError` for empty/whitespace — matches the local convention in the four mock streamers' `validateOptions` siblings. Closes the silent mode-divergence where the live branch surfaced the error at API time while the mock branch silently ignored the prompt and emitted the canned stream regardless. Both modes now fail loud at the call site the same way.
- Hardened `getStreamMode()`: trims `ANTHROPIC_API_KEY` so a whitespace-only value is treated as absent (falls back to mock mode); trims `ANTHROPIC_MODEL` so empty/whitespace falls back to `DEFAULT_MODEL`. Pre-#32, a whitespace-only API key would reach the SDK as an invalid bearer header, and an explicit `ANTHROPIC_MODEL=""` would propagate as `model: ""` to the SDK. `DEFAULT_MODEL` is now exported so tests can assert against it without hardcoding the string.
- 17 new vitest cases in `test/anthropic-stream.test.ts`: 3 type rejection, 3 value rejection, 1 mock-mode acceptance, 5 `ANTHROPIC_API_KEY` shape, 5 `ANTHROPIC_MODEL` shape. Full suite 208 / 208 pass (was 191).
- `docs/architecture.md`'s "no-key fallback (D-003)" section gains a paragraph citing #32 and the sibling streamer guards. No new `D-NNN` — pure extension of the established D-009-style portfolio sweep to the last unguarded entry points in `lib/`.

**Why this work, this session:** Iteration 3 of the night session loop. `nextjs-streaming-ai-patterns` was untouched since 2026-05-27 (build sequence position 11 among the untouched-stale repos). The four mock streamers + `checkpoint-stream` + `optimistic-decision`'s `decide()` already carry the entry-point validation pattern; `anthropic-stream.ts`'s two entry points (`streamText`, `getStreamMode`) were the last unguarded surfaces in `lib/`. Closing them saturates the validation arc.

**Open questions / blockers:** none — ready for review.

**Next session:** Continue the night-session loop. `ai-app-integration-tests` is the last untouched-since-2026-05-27 candidate (position 12, TS).

## 2026-06-17 — Issue #34: Workflow YAML-parseability lock
**Duration:** ~6 min · **Branch:** `session/2026-06-17-1932-issue-34`

Added `test/workflows-yaml-parseable.test.ts` (vitest, 3 tests for
`ci.yml`) and pulled `js-yaml` + `@types/js-yaml` into
`devDependencies`. Mirrors the `agent-orchestration-platform#42`
pattern.

**Why this work, this session:** Eleventh hop of the
`portfolio-ops#30` propagation arc.

**Open questions / blockers:** none — PR #35 open.

**Next session:** propagate to the last repo (`ai-app-integration-tests`).

## 2026-06-18 — Issue #36: timeout-minutes guard + lock test
**Duration:** ~25 min · **Branch:** `session/2026-06-18-0321-issue-36`

- Added `timeout-minutes: 20` to `app` in `ci.yml` (the longest job in
  this repo: `npm ci` + lint + typecheck + Vitest + Next.js build) and
  `timeout-minutes: 15` to `memory-check`.
- Added `test/workflows-timeout-minutes.test.ts` (Vitest) — 7 new tests:
  1 smoke + 2 jobs × 3 parametrized invariants (`timeout-minutes` is
  present, is an integer (not boolean/string), is in policy band
  `[1, 30]`). Each invariant fails as its own `it` so a regression
  names the offending job exactly.

**Why this work, this session:** GitHub Actions defaults to 360
min/job when `timeout-minutes` is unset, so a hung job (npm ci stall,
infinite typecheck loop, stuck Playwright wait) burns the full 6-hour
ceiling. `llm-eval-harness` PR #63 shipped the canonical first hop
(Python) and the portfolio-ops audit (#36) added a
`--check missing-timeout` fingerprint that surfaces every unprotected
repo weekly. Two more Python hops (`rag-production-kit#55`,
`chunking-strategies-lab#42`) preceded this; this PR is the first
**TypeScript** hop and unblocks propagation to the other Node/TS
portfolio repos (`ai-app-integration-tests`, `mcp-server-cookbook`,
`agent-orchestration-platform`).

**Open questions / blockers:** none. Test count 211 → 218 (+7), `npm
test` + `npm run lint` + `npm run typecheck` all clean.

**Next session:** continue propagation across remaining 7 unprotected
repos. Per build sequence: embedding-model-shootout (Python),
vector-search-at-scale (Python), python-async-llm-pipelines (Python),
agent-orchestration-platform (TS), mcp-server-cookbook (TS),
ai-app-integration-tests (TS), plus portfolio-ops itself.

## 2026-06-18 — Issue #38: concurrency guard + lock test
**Duration:** ~15 min · **Branch:** `session/2026-06-18-1525-issue-38`

- Added top-level `concurrency:` to `ci.yml` (`ci-${{ github.ref }}`).
- Wrote `test/workflows-concurrency.test.ts` — vitest + js-yaml, mirroring
  the timeout-minutes lock shape. 1 smoke + 3 invariants × 1 workflow
  = 4 new tests.

**Why this work, this session:** fifth per-repo hop in the
concurrency-lock arc and **first TypeScript hop** (prior four hops
landed in Python repos). Audit fingerprint shipped in portfolio-ops #41
surfaces every workflow missing the lock.

**Open questions / blockers:** none. Vitest 218 → 222.

**Next session:** continue propagation to remaining 7 repos (mix of
Python and TS — the TS template is now established here for future
Node-side hops).

## 2026-06-22 — Issue #40: mock streams — honor abort during unguarded post-sleep windows
**Duration:** ~30 min · **Branch:** `session/2026-06-22-1129-issue-40`

- Found during Phase A (Explore subagent flagged two abort windows; I traced `sleep` to confirm it resolves — not rejects — on abort): `mockToolStream` phases 1 and 5 re-check the abort signal after each `sleep`, but phases 3, 4, and 6 — and `mockJsonStream`'s final sleep — did not. Because `sleep` resolves immediately on abort, a cancelled stream could emit a fabricated `tool_result` for an aborted tool call, or report `message_stop: end_turn` instead of `interrupted`, corrupting the `stop_reason` the SSE route/UI use for interruption handling and breaking the documented abort contract.
- Fix: added a post-sleep `checkAborted()` (yield `interrupted` + return) after every sleep that precedes a yield, in both files. `mock-stream.ts` already guarded both sides.
- 3 deterministic race-window tests that pump each generator to exactly the unguarded window, abort, and assert `interrupted` (and no post-abort `tool_result`). Verified they fail on the pre-fix code. Suite 222 → 225, tsc + eslint clean. PR #41 ready.

**Why this work, this session:** the only open issue was a binary demo-capture task (not doable headless), so this was found by reading the core streaming libs. Interruption handling is a headline pattern of this repo, making a silent abort-contract violation high-value — strictly better than a synthetic fill.

**Open questions / blockers:** none.

**Next session:** the abort handling is now uniform across all three mock streams. If a future session wants more here, the live `anthropic-stream.ts` path and the SSE route handlers (`app/.../route.ts`) are the remaining surface to audit for the same resolve-on-abort race.

## 2026-06-22 — Issue #42: stream-text — make streamText abortable end-to-end
**Duration:** ~30 min · **Branch:** `session/2026-06-22-1519-issue-abort-live`

- Acted on the "remaining surface" lead from the #40/#41 session: that session fixed abort windows in the *mock* streams and flagged the live `anthropic-stream.ts` path and the SSE route handlers. The live path was worse than a race — `streamText` accepted no `AbortSignal` at all, so `client.messages.stream(...)` ran to completion after a client disconnect (token burn), and the mock path ignored the signal it already supports. The stream-text route's `cancel()` was an empty no-op whose comment *falsely* claimed cancellation "cascades back via the for-await break" — a `ReadableStream`'s `start()` loop does not auto-break on cancel.
- Fix: `streamText(prompt, { signal })` early-returns before `new Anthropic()` if already aborted (so an aborted live request never opens a network stream), forwards `{ signal }` to the SDK request and to `mockTextStream`, and re-checks in the loop. The route owns an `AbortController`, passes its signal in, and aborts from both `cancel()` and a `req.signal` listener — implementing the **D-007** abort chain (client → route → stream source) the path was silently violating. Comment corrected.
- 5 new tests (mock already-aborted yields nothing; mock mid-stream abort stops early; live already-aborted returns before SDK construction; route already-aborted emits no text frames; route `cancel()` resolves cleanly). Verified 4 of 5 fail pre-fix. Suite 225 → 230, tsc + eslint clean. PR ready.

**Why this work, this session:** the only open issue was a `priority:low` demo-capture task; this was a real correctness + cost bug in the repo's headline interruption-handling feature, already documented as the next lead. Higher value than a synthetic fill.

**Open questions / blockers:** none.

**Next session:** the other four SSE routes (tool-use, optimistic, error-recovery, partial-json) likely share the un-abortable pattern — filed as #43 (priority:med) to audit each against D-007 with a mirroring cancel test.

## 2026-06-22 — Issue #43: make the remaining SSE routes abortable
**Duration:** ~50 min · **Branch:** `session/2026-06-22-1953-issue-43`

- Picked the filed `priority:med` follow-up from #42/#44 (real product work in a priority-tier repo) over a dogfood, after five dogfood fixes earlier in the run. Audited the four routes: three are SSE streams with the gap, one (`optimistic`) is a unary JSON POST with nothing to abort (documented N/A).
- `error-recovery` was genuinely un-abortable — it passed no signal into `streamCheckpoints` at all, so a disconnect ran the generator to completion. Added a `signal` option to `streamCheckpoints` (returns at the next event boundary when aborted) and wired the route's AbortController in. `tool-use` and `partial-json` forwarded `req.signal` but owned no AbortController and had no `cancel()`, so the `reader.cancel()` Stop-button path didn't abort; both now own an AC and wire both disconnect surfaces, mirroring the canonical stream-text route.
- New `test/sse-route-cancellation.test.ts` (8 tests); 3 regression-catchers (error-recovery already-aborted + two `streamCheckpoints` signal tests) fail pre-fix, the rest are behavior assertions per the #42 precedent. Suite 230 → 238, tsc + eslint clean. PR #45 ready.

**Why this work, this session:** a concrete, filed `priority:med` issue extending validated #42 work — higher value than another dogfood sweep in a saturated portfolio.

**Open questions / blockers:** none.

**Next session:** all five SSE routes now honor the D-007 abort chain end-to-end. No remaining route-abort lead.

## 2026-06-23 — Issue #46: tool-stream Phase-2 abort recheck gap
**Duration:** ~20 min · **Branch:** `session/2026-06-23-0328-issue-46`

- Closed a one-phase gap in `mockToolStream`'s abort contract. Because `sleep` resolves (not rejects) on abort, every phase needs a post-sleep `checkAborted()` before its yield. Issue #40 added that guard to phases 1/3/4/5/6 but missed Phase 2 — so an abort during the sleep before `tool_use_start` emitted a `tool_use_start` event (model "wants to call get_weather") for a stream the client had already cancelled.
- Added the guard and an abort-race test that suspends the generator in the Phase-2 sleep, aborts while pending, and asserts `interrupted`. Red pre-fix, green post-fix. Suite 238 → 239, eslint clean.

**Why this work, this session:** found by the night session's Phase A parallel dogfood sweep; a real UX defect reachable through the live `app/api/tool-use` route when a user hits stop at the wrong moment.

**Open questions / blockers:** none. All six phases now uniformly honor the #40 abort contract.

**Next session:** no remaining known abort-window gaps in the tool stream.
