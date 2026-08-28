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

---
## 2026-06-23 — Issue #48: partial-json discarded a complete value on trailing junk
**Duration:** ~25 min · **Branch:** `session/2026-06-23-0428-issue-48`

- Fixed a contract violation in `parsePartialJson`. A complete top-level value followed by trailing junk (`{"a":1}extra`, `[1,2]extra`, `42 junk`) collapsed the whole result to `{value:null,isComplete:false}` — `repair()` never recorded where the top-level value ended, so it fell into `frameSnapshot` on an empty stack and returned null, discarding a value the caller had already fully received.
- Track `topLevelEnd` at the bare-literal and top-level-close sites, break on junk once complete, and re-emit `buffer.slice(0, topLevelEnd)`. Added trailing-junk tests. Red pre-fix, green post-fix. Suite 238 → 241, tsc + eslint clean. Mid-stream partial values and the real demo payload are unaffected.

**Why this work, this session:** found by a different-angle second pass in the night session's Phase A dogfood wave (the first pass on this repo's abort surface was already saturated). A real progressive-render contract bug in pure, unit-testable logic.

**Open questions / blockers:** none.

**Next session:** a malformed `\u` escape inside a closed string can null committed fields too (lower reachability, larger fix) — deferred.

---
## 2026-06-24 — Issue #50: partial-json nulled committed fields on a malformed string escape
**Duration:** ~35 min · **Branch:** `session/2026-06-24-0312-issue-50`

- Closed the bug the #48 session explicitly deferred (and never filed). `consumeString` tracked backslash-escape *state* but never *validated* the escape, so a closed string with an invalid escape (`\q`) or a non-hex `\u` escape (`\uXYZW`) was reported complete. `JSON.parse` then threw on the repaired buffer and the catch-all nulled **every** field — including ones fully transmitted before the bad string (`{"a":1,"b":"\uXYZW"}` → null instead of `{a:1}`).
- `consumeString` now validates the eight single-char escapes plus `\u` + 4 hex digits. A closed-form malformed escape returns `null` (so `repair` drops the value and keeps prior committed siblings); a truncated escape at end of buffer returns `complete:false` (still streaming, same drop-and-keep). Strictly more conservative — only drops what `JSON.parse` rejects anyway; valid escapes are untouched.
- 10 new tests (4 red-pre-fix catchers, 6 regression/edge guards). Red via `git stash` of the lib change, green after. Suite → 252 passed, tsc + eslint clean.

**Why this work, this session:** nextjs-streaming-ai-patterns was the only priority-tier repo past its 18h freshness floor (~22h), and this was a concrete, pre-scoped contract bug already documented in the prior session's "Next session" note.

**Open questions / blockers:** none.

**Next session:** lone-surrogate (`\uD800`) semantic validation was considered and deliberately skipped — `JSON.parse` accepts lone surrogates, so rejecting them would diverge from the "only drop what JSON.parse rejects" principle.

---
## 2026-06-24 — Issue #52: an unescaped control char in a string nulled all prior committed fields
**Duration:** ~20 min · **Branch:** `session/2026-06-24-1926-issue-52`

- `consumeString` validated escape sequences (#50) but walked past a *literal* unescaped control character (U+0000–U+001F: a raw newline, tab, `\x01`) and reported `complete: true`. JSON forbids literal control chars in strings, so the repaired buffer's `JSON.parse` threw and the catch-all nulled every field — the same drop-everything regression #50 fixed, reached by a different trigger.
- Added an unescaped-control-char check in `consumeString` (`return null` → drop-and-keep), preserving prior committed siblings. Red→green verified (4 failing cases before, all passing after). Full suite 259/259, ESLint + `tsc` clean.

**Why this work, this session:** the third issue of a multi-issue DAY run themed on seam-hardening; this one extends the partial-JSON correctness arc (#3 → #48 trailing junk → #50 escape validation → #52 control chars) and pairs with the cross-repo finiteness fixes shipped this run in rag-production-kit (#82) and chunking-strategies-lab (#66). nextjs-streaming-ai-patterns is in the D-009 priority tier.

**Open questions / blockers:** none.

**Next session:** lone-surrogate (`\uD800`) handling remains deliberately out of scope (`JSON.parse` accepts lone surrogates, so dropping them would violate the "only drop what JSON.parse rejects" principle — control chars, by contrast, ARE rejected by JSON.parse, which is why this fix is in scope).

---
## 2026-06-25 — Issue #54: trailing comma before a present closer dropped the whole value to null
**Duration:** ~25 min · **Branch:** `session/2026-06-25-1542-issue-54`

- `parsePartialJson` documents "trailing commas → trimmed before close", but that only held while the buffer was still open (the `frameSnapshot` path strips a trailing `[\s,]+`). When the closing `]`/`}` was already present after a trailing comma, `repair` re-emitted the raw buffer slice with the comma intact, `JSON.parse` rejected the whole document, and the catch-all returned `null` — dropping every already-transmitted field. `[1,2,]` → null, `{"a":1,}` → null, nested `[[1,2,],3]` → null. Trailing commas before a closer are one of the most common malformations in LLM-generated JSON, so this was both wrong and high-impact.
- Added a string-aware `stripTrailingCommas()` applied to the repaired candidate before the final `JSON.parse` (repair branch only — the valid fast-path is untouched). It removes a `,` followed by optional whitespace then `}`/`]`, skipping over string-literal contents (escape-aware) so a comma-bracket *inside* a string (`{"a":"x,]"}`) is preserved, and handles every nesting level. Since JSON forbids trailing commas, the pass can only turn invalid JSON valid — never change an already-valid parse. 10 new tests, red-without / green-with. Suite 259 → 269, eslint + tsc clean.

**Why this work, this session:** nextjs-streaming-ai-patterns is priority-tier (D-009) and was not touched earlier this run; the partial-JSON parser's robustness is the whole point of the streaming-patterns page, and this was a real, documented-contract violation on common real-world LLM output.

**Open questions / blockers:** none.

**Next session:** lone-surrogate handling remains deliberately out of scope (JSON.parse accepts lone surrogates; the "only drop what JSON.parse rejects" principle stands). The partial-json correctness arc now covers trailing junk (#48), escape validation (#50), unescaped control chars (#52), and trailing-comma-before-closer (#54).

## 2026-06-26 — Issue #56: decisionSplitOver now validates its clickRange
**Duration:** ~20 min · **Branch:** `session/2026-06-26-1520-issue-56`

- `decide()` validates its inputs, but its sibling diagnostic `decisionSplitOver(ids, clickRange)` — documented as the helper that pins the 50/50 split as *evidenced*, not aspirational — validated nothing about `clickRange`. A degenerate range silently produced a meaningless result: an inverted `{ from: 5, to: 2 }` ran zero iterations and returned `{ successes: 0, failures: 0 }` (a split property test would then pass vacuously on zero samples), a sub-1 or non-integer bound threw from deep inside `decide()` with an opaque `click_count` message, and a non-integer `to` silently truncated the iteration.
- Added `clickRange` validation: `from`/`to` must be integers ≥ 1 with `from <= to`, throwing a clear `decisionSplitOver(): …` error — symmetric with `decide()`'s own validation. The split logic and hash are untouched. 6 new tests (inverted/sub-1/non-integer-from/non-integer-to throw; valid and single-click ranges return the right sample total). Full suite 269 → 275, eslint clean on changed files.

**Why this work, this session:** nextjs-streaming-ai-patterns is priority-tier (D-009) and was stale past 18h; its only open issue (#16) is an environment-dependent binary demo-capture task, so per Phase A step 6 I filed a substantive code issue. This is the same silent-measurement-corruption class guarded across the portfolio (empty-`ks` in chunking-strategies-lab, `k_values` in embedding-model-shootout).

**Open questions / blockers:** none. (Note: the repo root has several untracked scratch `.ts` files from prior bug hunts that break a local `tsc --noEmit`; they are not in git, so CI typecheck on the committed tree is unaffected. Worth a cleanup pass some session.)

**Next session:** the optimistic-decision helper now validates both `decide` inputs and `decisionSplitOver` ranges; no further input-validation gap known there.

## 2026-06-26 — Issue #58: Error-recovery client resumes from checkpoint, duplicating tokens
**Duration:** ~25 min · **Branch:** `session/2026-06-26-2346-issue-58`

- The error-recovery route reports the exact drop position in the `error` SSE event's `last_token`, but `error-recovery-client.tsx` ignored it: the `error` branch read only `reason`, and `scheduleResume()` resumed from the most-recent **checkpoint**. Checkpoints fire every 5 tokens while the drop fires at 12 (independently), so tokens 11–12 are rendered before the drop yet `lastCheckpoint` is still 10. Resuming from 10 re-streams 11–12, which the client appends again — duplicated text at the seam. Reproduced via the real route: checkpoint-resume → 799 chars with a duplicated `"a chat a chat"`; drop-position-resume → clean 792 chars.
- Fixed by adding a pure `resumeTokenPosition(lastCheckpoint, droppedAt)` helper to `checkpoint-stream.ts` (furthest-forward known position; ignores missing/non-integer/behind `droppedAt`) and using it in the client's `error` branch with the server's `last_token`. 5 unit tests + 2 integration round-trip tests (resume-from-`last_token` reconstructs the clean stream exactly; resume-from-checkpoint is strictly longer and duplicates). Suite 275 → 282, typecheck + lint clean.

**Why this work, this session:** fifth issue of a multi-issue DAY run, completing a full sweep of all five priority-tier repos. The repo's only open issue (#16) is a binary demo-capture task (poor autonomous fit), so I dogfooded with an Explore agent and filed #58 from a reproduced finding.

**Open questions / blockers:** the repo root holds many untracked scratch `.ts` files from prior sessions (e.g. `find_real_bug.ts`, `verify_bug2.ts`) that break local `npm run typecheck`/`lint` but are untracked so never reach CI. A future cleanup session could `git clean`-review them. A minor `phase` stale-closure in `run()` (recovering indicator may not clear promptly) is UI-only and unfiled.

**Next session:** priority-tier sweep is complete for this run; rotate to non-tier repos or revisit the unfiled runners-up.

## 2026-06-27 — Issue #60: guard the SSE read loop so Interrupt isn't lost
**Duration:** ~30 min · **Branch:** `session/2026-06-27-0335-issue-60`

- `tool-use-client.tsx` and `partial-json-client.tsx` wrapped only the initial `fetch()` in try/catch; the subsequent `while (true) { reader.read() … }` SSE loop was **unguarded**. Clicking Interrupt (`AbortController.abort()`) rejected the in-flight `read()` with an `AbortError` that escaped `run()` as an unhandled rejection — `phase` never became `interrupted`, `isStreaming` stayed true, and the Run/Interrupt buttons stayed disabled (UI wedged). This violated `docs/tool-use-state-machine.md` (the `abort() → interrupted` transition). The sibling `streaming-text-client.tsx` was already correct.
- Extracted the identical loop into `lib/sse-stream.ts` (`pumpSseFrames` + an `isAbortError` predicate) and had each client `await pumpSseFrames(reader, handleFrame)` inside a try/catch mapping `AbortError → interrupted`, else `→ error` — also reusing `isAbortError` in the existing fetch-catch (dedup). Added 9 unit tests, including the regression guard that a reader rejecting mid-stream still delivers prior frames then propagates the abort. Removed 24 untracked root-level scratch `.ts` files a prior dogfood agent had left behind (they broke `tsc --noEmit`). vitest 282 → 291, tsc + eslint clean.

**Why this work, this session:** fifth issue of a multi-issue NIGHT run; a priority-tier repo with a documented-contract violation surfaced by a parallel dogfood agent, fixed via the repo's established extract-to-`lib`-and-unit-test pattern.

**Open questions / blockers:** none.

**Next session:** all three streaming clients now guard their read loops uniformly; a full React-render (Playwright) test of the button-re-enable UI remains deferred (no RTL harness in the repo).

## 2026-06-27 — Issue #62: optimistic-rollback demo never showed the rollback
**Duration:** ~20 min · **Branch:** `session/2026-06-27-0425-issue-62`

- `scripts/capture_demo.ts` clicked the first item (`untitled-1.txt`) twice and the README claimed the second click triggers the rollback — but the oracle `decide()` *succeeds* on click 2 for `untitled-1.txt` (it rolls back only at click 3). So the recorded 60s demo showed two successive successes and never the rollback animation the pattern exists to demonstrate.
- The oracle is correct and has a documented "exact 50/50" property (pinned by `decisionSplitOver`), so I did **not** bias it. The demo's intent is to show a rollback, so I repointed the capture driver to `untitled-2.txt` (which the oracle rolls back on click 2) and updated the README prose, leaving the oracle untouched. Added a unit test pinning `decide({id:'untitled-2.txt', click_count:2}).ok === false` so a future oracle/hash change can't silently re-break the recording. vitest 282 → 283, tsc + eslint clean.

**Why this work, this session:** twelfth issue of a multi-issue NIGHT run; surfaced by a second-pass dogfood of priority-tier nextjs (the first pass found #60).

**Open questions / blockers:** none — the actual GIF is regenerated by the operator-run capture; this makes the next take correct and guards the contract.

**Next session:** the optimistic-rollback capture now reliably shows the rollback; oracle 50/50 contract preserved.

## 2026-06-27 — Issue #64: error-recovery phase stuck on "recovering…"
**Duration:** ~25 min · **Branch:** `session/2026-06-27-1527-issue-64`

- The error-recovery demo's phase indicator sat on the amber `recovering…` banner for the entire successful resume stream, only flipping to `done` at the end — mis-teaching the "recover, then keep streaming" pattern. Root cause: the recovering→streaming transition read a stale-closure `phase`. `run` is recreated each render but is only ever invoked as the render-0 closure (mount effect + `scheduleResume`), so its captured `phase` is permanently `"idle"` and the `if (phase === "recovering")` guard never fired.
- Extracted the transition into a pure `phaseOnFirstChunk` reducer in `lib/recovery-phase.ts` (repo's lib-extraction convention, cf. `lib/optimistic-decision.ts`) and applied it via `setPhase(phaseOnFirstChunk)` — the functional updater reads the live phase, so a resume advances to `"streaming"` as tokens flow. Unit-tested the transition table.

**Why this work, this session:** second find from the Phase A 5-repo priority-tier dogfood sweep (alongside chunking-strategies-lab #78); the other three priority-tier repos returned honest "no solid bug".

**Open questions / blockers:** none. A full jsdom/RTL component-render test was out of scope (vitest env is node-only); the pure reducer + functional-updater usage is the in-convention faithful fix.

**Next session:** error-recovery phase labels are correct on resume; consider the secondary streaming-text-client error-frame dead-code fallback the dogfood agent noted in passing (lower severity).

## 2026-06-29 — Issue #66: error-recovery recovery counter spelled "recoveryies"
**Duration:** ~18 min · **Branch:** `session/2026-06-29-0310-issue-new`

- The error-recovery page's recovery-count chip rendered `2 recoveryies` for any count ≥ 2 — the inline JSX appended `ies` to the whole word (`recovery{n > 1 ? "ies" : ""}`) instead of replacing the trailing `y`. The chip is gated on `n > 0` and the `n = 1` case is correct by accident, so every multi-recovery render was wrong. This is on the demo path: the page exists to drop-and-resume, and the planned demo capture (#16) walks exactly that flow.
- Extracted the count-label rendering into a pure, dep-free `lib/plural.ts` (`pluralizeCount`), following the #64 `recovery-phase.ts` extract-to-testable-pure-function precedent, fixed the pluralization there, and routed both the `recoveries` chip and the sibling `partial-json` `day(s)` label through it. Unit-tested with 7 cases.

**Why this work, this session:** first issue of the night run. Phase A selection rule 1 picked `nextjs-streaming-ai-patterns` (only priority-tier repo over its 18h floor, at 32h); its sole open issue (#16) is an operator-blocked demo-binary capture, so I dogfooded the component, filed #66, and fixed it — the saturated-state dogfood→issue→PR pattern.

**Open questions / blockers:** none. #16 (demo binary capture) stays blocked on JT — needs a headed Playwright run + ffmpeg + committing a video binary.

**Next session:** count-label pluralization is centralized in `lib/plural.ts`; reuse it for any new count chips.

## 2026-06-29 — Issue #68: docs claimed parser exposes a committedAny flag (it doesn't)
**Duration:** ~9 min · **Branch:** `session/2026-06-29-0410-committedany-doc`

- README:41 and architecture.md:153 said the partial-JSON parser "exposes a `committedAny` flag" driving the UI fade-in, but `committedAny` is a private `repair()`-internal `Frame` field, never returned. The public `PartialJsonResult` is `{ value, isComplete }`, and the client uses per-field presence in `value` + `isComplete`. Reworded both docs to the real surface. The MEMORY references (internal design) are correct + append-only, left as-is.

**Why this work, this session:** thirteenth issue of the night run, from the final doc-contract subagent sweep. Second PR in this repo this session (alongside #67); both append MEMORY → serial rebase at merge time expected.

**Open questions / blockers:** none.

**Next session:** the partial-JSON docs describe the actual exported `{ value, isComplete }` surface.

## 2026-06-30 — Issue #70: a drop on a checkpoint boundary suppressed that checkpoint, duplicating tokens on the no-error-frame resume
**Duration:** ~20 min · **Branch:** `session/2026-06-30-1928-issue-70`

- In `streamCheckpoints` (`lib/checkpoint-stream.ts`) the `dropAfter` drop check ran *before* the checkpoint emission. So when a drop landed exactly on a checkpoint boundary (`dropAfter` a multiple of `CHECKPOINT_EVERY`), it threw before yielding `checkpoint{last_token: N}` for the just-emitted token. The error-frame resume path is robust to this (it uses `resumeTokenPosition`, which takes the furthest-forward of the last checkpoint and the server-reported drop position). But the **no-error-frame** path — a raw network drop, documented at `:132-134` and locked by `test:209-212` — falls back to the last *received* checkpoint, so the client rewound to the prior checkpoint and replayed `CHECKPOINT_EVERY` already-rendered tokens: the duplicated drop seam this pattern exists to prevent (`:129`). Sibling to #58.
- Fixed by reordering so the boundary checkpoint is yielded before the drop check throws — what a real server does (emit token N, emit the due checkpoint, then the connection dies). +3 tests: `dropAfter` 5 and 10 now carry the boundary checkpoint as the final event before the throw (both fail pre-fix via a stash-and-rerun inverse check); `dropAfter: 7` ordering is unchanged (checkpoint only at 5, never at 7). Suite 303 → 306, lint + typecheck clean.

**Why this work, this session:** DAY multi-issue run. Phase A merged 7 ready sibling PRs (one per non-nextjs repo) then found **zero open priority:high issues across all 12 repos** — a fully saturated portfolio. nextjs-streaming-ai-patterns was the only priority-tier repo past its 18h freshness floor (~28h stale), so I dogfooded it (Phase B step 5). Two serial Explore hunters: the first exhausted `partial-json.ts` and confirmed it correct; the second (routes + mock streamers + checkpoint-stream) surfaced this ordering issue. The hunter's "breaks the recovery protocol" framing was imprecise — I verified the error-frame path is robust and the real defect is only on the no-error-frame fallback — so the issue and fix are scoped to that.

**Open questions / blockers:** none — ready for review. The repo's only other open issue (#16, the binary demo recording) needs a running dev server + Playwright chromium + ffmpeg + human frame verification; it remains a JT-side task.

**Next session:** continue the loop. Priority-tier repos are all fresh now; rotate per build sequence.

## 2026-07-03 — Issue #72: parsePartialJson dropped a nested empty container value (and its key)
**Duration:** ~30 min · **Branch:** `session/2026-07-03-1519-issue-72` · **PR:** #73

- `parsePartialJson('{"a": [')` returned `{}` instead of `{"a": []}` — the empty array value, and the `"a"` key with it, were dropped. Root cause: `frameSnapshot` (`lib/partial-json.ts`) popped *every* innermost frame with `committedAny === false`. That's correct for an object that has started a pair but not committed a value (`{"id":` — you can't close `{"id":}` to valid JSON), but wrong for a *truly-empty* container: an empty array/object is a complete, valid value and should be closed, not dropped. This contradicted the docstring ("open array or object → appends the missing closers"), `frameSnapshot`'s own "empty containers remain reachable" comment, and the top-level `[` → `[]` behavior. In the progressive-render UI it caused a flicker — the model emits `{"a": [`, the UI renders `{}` (key "a" vanishes), then `{"a":[1]}` (reappears).
- Fixed by narrowing the pop condition: pop a `committedAny === false` frame only when it's an **object** `expecting "colon"/"value"`. Truly-empty containers (any array with no committed content, or an object still `expecting "key"`) are kept and closed. `{"a": [`→`{"a":[]}`, `{"a": {`→`{"a":{}}`, `[{`→`[{}]`, `[[`→`[[]]`. +7 regression tests including a top-level/nested consistency assertion and a guard that the trailing started-pair (`{"id":`) is still dropped (`test:88`). Suite 306 → 313, typecheck + lint clean.

**Why this work, this session:** DAY multi-issue run, first issue. Phase A merged 4 clean ready PRs (mcp-server-cookbook #81, llm-eval-harness #139, rag-production-kit #117, embedding-model-shootout #82) and the audit came back clean (12 repos + the known operator-blocked portfolio-ops `trending-daily` stale-schedule). Portfolio stayed saturated — zero open priority:high issues — so I dogfooded the stalest priority-tier repo (nextjs, ~64h). Two parallel Explore hunters: one clean, one surfaced this. Reproduced firsthand before fixing.

**Open questions / blockers:** none — ready for review.

**Next in this session's loop:** file + fix the `error-recovery` route's missing `X-Accel-Buffering: no` header (the other three SSE routes all set it) as issue #2.

## 2026-07-03 — Issue #74: error-recovery SSE route missing X-Accel-Buffering: no
**Duration:** ~15 min · **Branch:** `session/2026-07-03-1523-issue-74` · **PR:** #75

- `error-recovery` was the only SSE route not sending `X-Accel-Buffering: no`. The other three streaming routes (`stream-text`, `tool-use`, `partial-json`) all set it. Behind a reverse proxy that honors the header (nginx et al.), the response can be buffered and flushed in one burst — which for this route collapses the incremental checkpoint → drop → resume sequence into a single late delivery, defeating the entire recovery demo. `Cache-Control: no-transform` (already present) governs content transformation, not proxy buffering, so it isn't a substitute.
- Fixed by adding the header, matching the siblings. +2 route-header regression tests (asserts the header, plus SSE content-type and no-transform cache-control). Inverse-checked by reverting the route change and confirming the header test fails. Suite 306 → 308, typecheck + lint clean.

**Why this work, this session:** second issue of the DAY multi-issue loop, same priority-tier repo (nextjs). Found firsthand during the route review I did while working #72 — not from an agent. Filed #74, worked it same session.

**Open questions / blockers:** none — ready for review. Sibling note: this PR and #73 both append to the same MEMORY files, so whichever merges second needs a trivial serial rebase (the documented append-only sibling-conflict pattern).

**Next in this session's loop:** priority-tier repo nextjs now has no more autonomous unblocked defects surfaced; rotate to the next repo per selection rules (llm-cost-optimizer / chunking cross the 18h floor soon, else non-tier by build sequence).

## 2026-07-04 — Issue #76: architecture-doc symbol-resolution lock (TS side of portfolio-ops #55)
**Duration:** ~35 min · **Branch:** `session/2026-07-04-0313-issue-76` · **PR:** #77

- `test/architecture-doc.test.ts` locked path tokens, PATTERNS-slug coverage, active decisions, and banned phrases — but never checked that the *symbols* `docs/architecture.md` names actually exist. A doc renaming `streamText` → `streamTokens` would pass CI green (the drift class portfolio-ops #55 catalogued portfolio-wide). Added a symbol-resolution invariant: multi-word camelCase/PascalCase inline-code identifiers (fenced blocks stripped) resolved against a static scan of every top-level declaration across `lib/`+`components/`+`app/`, **exported or internal** — internal matters because `validatePrompt`/`validateOptions` are non-exported guards the doc names. Two hard-pinned exception sets carry framework APIs (`ReadableStream`, `useOptimistic`) and object fields (`isComplete`). An injected-drift test runs the shared resolver so the green can't be vacuous; also negative-controlled by renaming a live doc symbol and watching the suite fail.
- All seven current candidates resolve — no live drift, so this is a preventive lock like most of the Python siblings. Suite 315 → 322, `tsc --noEmit` + eslint clean.

**Why this work, this session:** first issue of the NIGHT loop. Portfolio has zero `priority:high` issues and no freshness floor crossed; the only actionable, non-blocked backlog is portfolio-ops #55's TS-side propagation (the Python side finished in the prior DAY run, whose four tail PRs I merged in Phase A). nextjs is priority-tier, so it won the pick among the three TS repos.

**Open questions / blockers:** none — ready for review. The TS resolver is genuinely per-repo (not a port), as #55 anticipated.

**Next in this session's loop:** propagate to the remaining TS gap repos — `mcp-server-cookbook` (mjs test) and `ai-app-integration-tests` (ts test) — one PR each, each adapted to its own doc's citation style.

## 2026-07-07 — Issue #78: AbortController unmount-teardown parity (partial-json & error-recovery clients)
**Duration:** ~35 min · **Branch:** `session/2026-07-07-2311-issue-78` · **PR:** #79

- Two of the four streaming client components leaked their in-flight `fetch`/reader when unmounted mid-stream. `partial-json-client.tsx` had **no unmount teardown at all** (didn't even import `useEffect`); `error-recovery-client.tsx`'s cleanup only set `aborted.current = true` — masking the symptom by halting further `setState`/reconnect — but **never called `controller.abort()`** (the controller was a per-`run` local, so the signal handed to `fetch` never fired). A browser `fetch` isn't auto-aborted on component unmount, so both left the HTTP connection open until server EOF and never tripped the route's abort-on-disconnect chain (D-007). The two correct siblings (`streaming-text-client`, `tool-use-client`) already abort on unmount.
- Fix: `partial-json` imports `useEffect` and adds an unmount abort (mirrors `tool-use-client`); `error-recovery` hoists the controller into a `controllerRef` and aborts it in the existing cleanup. Added `test/streaming-client-cleanup.test.ts`, a source-level parity lock (idiom of `public-surface.test.ts`) that discovers every `components/*.tsx` owning an `AbortController` and asserts each aborts on unmount, so a fifth client can't silently reintroduce the leak. Verified it fails on pre-fix source (3 failures), passes after fix. Suite 322 → 331, `tsc --noEmit` + eslint clean.

**Why this work, this session:** static issue queue is exhausted (zero `priority:high` open in any priority-tier repo; only headless demo captures + a JT-gated decision-revisit remain), so work came from fresh-lens dogfood hunts. Ran four parallel hunters — percentile computation, TTL/expiry boundary, retry/backoff, and nextjs cancellation/cleanup; three came back honestly empty (the portfolio's math/time/retry paths are well-hardened), and the cancellation lens surfaced this real parity gap on nextjs, the stalest priority-tier repo. Filed #78 with both findings reproduced firsthand.

**Open questions / blockers:** none — ready for review.

**Next in this session's loop:** rotate to the next repo per selection rules; the AbortController-unmount lens is now swept on nextjs (only client-owned fetch controllers live here). Continue fresh-lens hunts against the saturated portfolio, stopping cleanly within the DAY 2–4 issue target.

## 2026-07-09 — Issue #80: error-recovery raw-drop resume-seam duplication
**Duration:** ~30 min · **Branch:** `session/2026-07-09-1538-issue-80` · **PR:** #81

- The error-recovery client rendered every streamed token but discarded each text event's `index`, so on a *raw* network drop (no SSE `error` frame) it resumed from the last checkpoint — which lags up to 4 tokens behind the screen — replaying and re-appending already-rendered tokens and duplicating text at the drop seam. #58 fixed this for the error-frame branch; the raw-drop branches were left exposed (the #71 comment already named the hazard).
- Tracked the furthest rendered index and resume from `Math.max(lastCheckpoint, lastRendered)`. Added a behavioral regression (real `streamCheckpoints` raw-drop → resume reproduces the clean stream) and a source-level wiring lock in the #78 idiom; both locks fail on the pre-fix client. Full suite 335 pass, tsc + eslint clean.

**Why this work, this session:** the static queue was globally saturated (11 of 12 dogfood hunt agents returned empty this run); a parallel nextjs hunt surfaced this, and it reproduced firsthand against the real streamer.

**Open questions / blockers:** none — ready for review.

**Next session:** streaming resume-seam correctness is now swept on error-recovery (raw-drop + error-frame branches at parity). The other three streaming clients (partial-json, stream-text, tool-use) have no checkpoint-resume construct, so this lens doesn't transfer to them.

## 2026-07-10 — Issue #82 (decision-revisit): partial-json started-pair drop flicker (~30 min, night)

**What got done.** Investigated a non-monotonic flicker in the partial-JSON parser: `frameSnapshot`'s pop loop drops an inner object frame that started a pair (`{"id":`), but the parent's `lastSafeEnd` predates the child's opening brace, so the pop erases the parent's key/element (`{"a": {"b":` → `{}`, key `a` lost, instead of `{"a":{}}`). Verified firsthand across 6 repro cases plus the appear/vanish/reappear flicker, reachable in the shipped demo's `daily_plan` array.

Built the fix (remove the pop loop; close every frame in place at its own `lastSafeEnd`, which already excludes the half-typed pair) — all 9 repro cases pass — **but it fails the two explicit `#72 guard` tests** that deliberately lock the drop behavior. Since #72 chose (adjacently-tested) to surface a truly-empty container but drop a started pair, this is a *deliberate prior decision*, not an oversight. Per the handoff (§1.5) and session protocol, I did not overturn it: **reverted the code (tree untouched, 57/57 green) and reclassified #82 as a `decision-revisit`** for JT, with both positions laid out (A: surface consistently, recommended; B: also drop the empty `{`) and the new flicker evidence.

**Why prioritized.** Found via a sibling-incomplete-fix hunt on the #72/#73 partial-json cluster; the flicker is a real UX regression, but the resolution touches an explicit guarded decision.

**Open questions / blockers.** JT to choose A vs B on #82. Do not re-file/fix until then.

## 2026-07-13 (Night) — Issue #83: architecture.md tree omitted 3 shipped lib/ modules
**Duration:** ~25 min · **Branch:** `session/2026-07-13-0518-issue-83` · **PR:** #84

- The `docs/architecture.md` directory tree listed 8 of `lib/`'s 11 `.ts` modules. Missing: `sse-stream.ts` (the shared `pumpSseFrames`/`isAbortError` SSE pump, #60), `recovery-phase.ts` (the `RecoveryPhase` model + `phaseOnFirstChunk`, #64), and `plural.ts` (`pluralizeCount`, #66) — each with a dedicated test file, so all three are first-class modules embodying the `lib/`-extraction-for-testability principle the doc itself describes.
- Un-pinned because the arch-doc lock's path check (`appSlugRefs`) only validates `app/<slug>/` *directory* tokens, and `stripFences()` removes the tree code block before the symbol scan — so `lib/` file staleness sailed through CI green. The "arch-doc drift beyond the lock lens" class.
- Added the three modules to the tree with role comments and a code-tied completeness lock: every `.ts` under `lib/` and every `.tsx` under `components/` on disk must be named by basename in the doc; hard-pinned `TREE_DIRS = [lib, components]` + inverse injected-drift guard. Verified the lock flags exactly the three drifted modules on the pre-fix doc. `npm test` 339 pass (arch-doc file 16 → 20 tests); lint + typecheck clean.

**Why this work, this session:** ported the "arch-doc drift beyond the lock lens" from chunking-strategies-lab #122 (same night) — hunt README/architecture claims the lock tests *don't* pin. The `components/` and `app/api/` trees were audited and are already complete.

**Open questions / blockers:** none — ready for review.

**Next session:** the directory-tree completeness gap is now locked in nextjs. Check the other two JS arch-doc repos (mcp-server-cookbook, ai-app-integration-tests) and the Python repos' trees for the same class — a fenced directory tree stale vs the shipped module set.

## 2026-07-14 (night, issue #85) — error-recovery SSE param doc-drift (?since=N vs ?checkpoint=N)

README.md and docs/architecture.md described the error-recovery reconnect as `?since=N`, but the route reads `?checkpoint=N` (`url.searchParams.get("checkpoint")`) and the client sends `?checkpoint=`. A reader following the docs would build a client with the wrong param and silently never resume. The route docstring also documented a `session=S` param the route never reads.

Fix: corrected the two prose sites to `?checkpoint=N`, dropped the phantom `session=S` from the docstring, and added a lock test (`test/error-recovery-doc-param.test.ts`) that extracts the route's real `searchParams.get(...)` key as ground truth and asserts the docs reference `?checkpoint=` and never the stale `?since=`/`session=`. Verified firsthand (route + client both use checkpoint; no test pinned the strings). typecheck + lint clean, 342 tests pass (+3).

The lens: doc-drift beyond the lock lens — the arch-doc symbol/tree locks (#76/#83) pin symbols and filenames but NOT prose query-param strings, so a `?since=` vs `?checkpoint=` drift went unguarded. Found via the run-shipped-example / doc-drift agent wave on the priority-tier repos. Shipped as PR #86.

## 2026-07-15 — Issue #87: error-event docstring omits last_token (sibling of #85)

#85 fixed the query-param line of the error-recovery route docstring but left the
error-event data-shape line documenting `{"reason":"…"}` — while the simulated-drop
path actually sends `{reason, last_token}`. That `last_token` is load-bearing: the
client reads it off the error frame to resume from the exact drop position, and two
tests depend on it. A reader following the docstring would resume from the lagging
checkpoint fallback instead, reintroducing the duplicated-drop-seam #58 prevents.

Fixed the docstring and extended the #85 doc-lock test to pin the documented
error-event `last_token` against the route's drop-path `send`. Verified firsthand.

Process note: nextjs CI runs `eslint .` with no prettier, and the committed route.ts
isn't prettier-formatted — running prettier --write reformatted untouched pre-existing
lines, so I reverted that and kept a minimal hand-edited diff.

Why prioritized: sibling-incomplete-fix meta-lens on the Phase-A-merged #85, correctly
scoped around the JT-gated #82 partial-json area.

## 2026-07-17 — Issue #89: README SSE envelope contract drift

The README's headline paragraph claimed all five patterns share one
`data: {kind, ...}` SSE envelope and every client tags events by `kind`. That's
only true for the error-recovery pattern. Tool-use and partial-json tag their
variants by the SSE `event:` field (event types), and stream-text just emits
`data: {text}` — which is exactly the mechanism D-006 decided ("client unions
over event types, dispatches in one place"). So the code was correct per D-006
and the README's phrasing was the drift; I checked D-005/D-006 first to be sure I
wasn't papering over a real code violation. Rewrote the paragraph to describe the
event-type mechanism (with `kind` noted as the checkpoint pattern's own
discriminator) and added a code-tied lock test mirroring the #85 doc-drift lock.
architecture.md was already accurate, so it's untouched. Shipped as PR #90.

## 2026-07-31 — `stream-text` threw on a plain `Request` (#91, PR #92)

`error-recovery` has read its query param through `new URL(req.url)` since #58,
carrying a comment that spells out why: `req.nextUrl` is a `NextRequest`
extension, so a route reading it only works via the Next.js routing layer, not
when handed a plain `Request`. `stream-text` kept `req.nextUrl` and therefore
threw an opaque `TypeError: Cannot read properties of undefined (reading
'searchParams')` before the handler did anything.

The tell was already in the test suite: `error-recovery-route.test.ts` builds a
plain `new Request(...)`, while `stream-text-route.test.ts` was forced to build a
`NextRequest`. The in-process test shape that comment describes was available to
one route and not the other, purely because of where the fix stopped. Sweeping
all five routes confirmed `stream-text` was the last `req.nextUrl` site —
`tool-use`, `partial-json` and `optimistic` touch only `req.signal` and
`req.json()` — so this completes a uniform contract rather than shuffling the
inconsistency along.

Having now applied the same one-line fix twice, I locked the contract instead of
waiting for a sixth route: a source scan over every `app/api/**/route.ts`,
stripping comments first, since the routes *document* why they avoid `nextUrl`
and that prose would otherwise trip the scan explaining it.

A test-design note worth keeping. My first behavioral test asserted the streamed
body contained the prompt, and it failed — the mock streamer emits a fixed
fixture and ignores the prompt entirely, deliberately, because it is
deterministic by design. Spying on `streamText` instead asserts the stronger
property: the param actually reached the streamer, not merely that nothing threw.
Verified the lock fails on the pre-fix tree and passes after; 355 tests green.

The transferable lens: **a fix whose rationale is written into a comment is a
high-yield sibling-hunt seed.** The comment states a general contract; grep its
key phrase across sibling files and see which sites never got it.

## 2026-08-13 — Four copies of the SSE frame parser, disagreeing four ways (#93)

**Duration:** ~50 min · **Issue:** #93 · **PR:** #94

This repo is a patterns reference for streaming in Next.js, and it shipped four inlined copies of the SSE frame parser — one per client. Extracting all four verbatim into a scratch file and running one input table through them side by side produced a three-way disagreement on four separate inputs. None of it was derivable by reading any single copy; it was visible only in the matrix.

The space after a field name is optional in the SSE wire format, but three of the four tested for `"data: "` with the space, so a compact `data:{"x":1}` failed the test, left the buffer empty, and the whole frame was discarded — no throw, no log, nothing. `event:` without a space gave three different answers, one of them a default that matches no case in the downstream switch, which is a silent drop wearing a different hat. One client assigned where the other three appended, losing the first of two `data:` lines. And one never trimmed the value, so under CRLF framing the event name kept its carriage return and every equality check downstream failed.

The pointer was sitting in `lib/sse-stream.ts`'s own docstring. That file exists because each client used to inline the *read loop*, they diverged, and #60 centralised it. The parser right next to that loop was left duplicated and drifted the same way. When a file exists because duplication caused a bug, it's worth asking what else was duplicated alongside it and never moved.

Consolidating a function that has no single "pre-fix" version needs a different anti-vacuous check, so each divergence case was replayed against all four originals and asserted to fail on exactly the copies that had the bug. That pins the tests to real behaviour differences rather than to my reading of them.

Two things left alone deliberately: multi-line `data:` is still joined without the spec's newline separator (all four agreed on that, and it's what makes a split JSON object reassemble), and each client keeps its own default event name, because that difference is load-bearing in the switch. Consolidate the parsing, not the policy.

**Also spotted, not filed:** `pumpSseFrames` drops a trailing partial frame if a stream ends without a `\n\n`. Real, but not reachable from this repo's own routes.

## 2026-08-14 — the parser was hardened for a wire format the pump couldn't deliver (#95)

`pumpSseFrames` split the read buffer on the literal string `"\n\n"`. The SSE
spec ends a line with any of `\r\n`, `\n`, or `\r`, so the event separator — a
blank line — has three byte forms, and `indexOf("\n\n")` finds exactly one of
them. A CRLF blank line is `\r \n \r \n`: no adjacent `\n\n` anywhere in it.

The loss was total rather than partial. A CRLF- or CR-framed body yielded
**zero** frames: every byte piled up in the buffer, the inner loop never ran,
and the function resolved *successfully* having called `onFrame` zero times.
The component landed on its normal completion path with no content and no
error.

This came out of a second-order sibling hunt on a PR merged during this same
session's Phase A. #94 had just consolidated four inlined SSE frame parsers
into one shared module, so I read the new module and asked what the layer above
it does. The thread was a docstring: `parseSseFrame` trims its values
*because*, in #93's words, "under CRLF framing the event name kept its `\r` and
every `event === "..."` comparison downstream silently failed". A docstring
that justifies a fix by naming a wire format is a claim that the wire format
reaches it — and this one couldn't. The fix one layer down was unreachable.
Worth keeping as a lens, particularly since this repo had come back empty on
the previous two runs and the freshly-shipped diff is what broke the drought.

The fix had a hazard of its own that nearly went in. Normalizing each decoded
chunk with a plain `replace(/\r\n|\r/g, "\n")` is wrong across a read boundary:
a chunk ending in `\r` followed by a chunk starting with `\n` becomes `\n\n`
and manufactures a frame boundary that isn't in the stream. The chunk-final
`\r` has to be held back until the next read resolves it, and an unresolved
carry at end-of-stream is a lone-CR terminator after all. Three tests cover
that straddle from both directions. The general rule: any per-chunk text
normalization inside a streaming decoder needs the same carry treatment
`TextDecoder`'s own `{stream: true}` gets — if the pattern you're rewriting can
span two reads, you must buffer its prefix.

I also built the wrong half first, and a named test caught it. The issue
proposed flushing an unterminated trailing frame, and that turned
`does not emit a trailing partial frame with no terminator` red. The test is
right: a truncated tail is very likely truncated JSON, and delivering it would
hand the parser a payload that either fails or, worse, parses into a partial
object. So the flush was reverted, the separator fix kept, and the drop pinned
in the new file too — including under CRLF framing, so the normalization can't
quietly start flushing truncated tails. This is the same playbook as the
pyasync#90 episode: grep the suite for a test that names the contract before
calling it a bug.

The real question underneath went to JT as #97, because it's a third option
neither side currently takes — reject loudly rather than drop silently or
deliver a partial. The sharp constraint there is that an abort *also* leaves a
partial frame in the buffer, so a naive "throw on non-empty buf" would
reclassify every Interrupt click as `error` instead of `interrupted`, which is
exactly the regression #60 was fixed to prevent.

Neither behaviour fires against this repo's own routes — every bundled SSE
producer emits LF and terminates every frame. This is robustness against a
conforming upstream, which is what a patterns library exporting these functions
from `lib/` is read for, and it's the argument #93 already accepted.

Repo fact worth remembering: prettier is not CI-enforced here. 63 files already
fail `npx prettier --check`; CI runs lint, typecheck, test and build only. I
formatted my two files and left the rest alone.

## 2026-08-19 — a lenient parser feeding a strict-looking check (#98)

Grepping this repo for prose assertions turned up a one-line trailing comment
in the error-recovery route: `const dropOnce = checkpoint === 0; // resume
requests never drop`. Running a 15-row variant table of `?checkpoint=` values
through the route in-process, printing frames / text-frames / event-kinds, was
enough.

```
"0"        15  12  {data:14, error:1}    documented drop
"5"       159 132  {data:158, done:1}    documented clean resume
"999999"    1   0  {done:1}              <- 200 OK, demo shows nothing
"1e5"     164 136  {data:163, done:1}    <- resumed from 1, not 100000
"1e400"   164 136  {data:163, done:1}    <- resumed from 1
"13.9"    150 124  {data:149, done:1}    <- resumed from 13
```

The route did `Number.parseInt(raw, 10)` and then checked
`Number.isInteger(n) && n >= 0`. That check reads like validation and can never
be false for a numeric *prefix* string, because `parseInt` has already thrown
the rest away. The general shape is worth remembering: **when a lenient parser
feeds a strict-looking check, the check is decorative.** `abc`, `""`, `NaN`,
`-3` and `0x10` all clamped to 0 correctly; the prefix class was the one shape
neither validated nor clamped, and it produced a *different, plausible*
position with no signal.

The worse half was `?checkpoint=999999`: HTTP 200, one `event: done` frame,
zero text frames. Well-formed SSE, correct status, and a demo whose entire
point is showing recovered prose rendering nothing.

**I got the scope wrong first and the test suite caught it.** My filed proposal
also put an upper bound in `checkpoint-stream`'s `validateOptions`. I built it,
and it turned a named existing test red: "startAfter beyond TOTAL_TOKENS yields
no text events and no checkpoints." That test is right, so I reverted the
library half and posted a correction on the issue before shipping.

The distinction is the interesting part, and it generalises. `validateOptions`'
existing *lower* bounds reject values that make the generator do something
**actively wrong** — `dropAfter = 0` fires the drop on the first text event,
contradicting its own docstring. An out-of-range *upper* value is a coherent
no-op: "yield the tokens after n" with `n >= TOTAL_TOKENS` correctly yields
nothing. A lower bound and an upper bound are not automatically the same kind
of guard, and the 200-with-zero-text is an operator-input problem, so the clamp
belongs at the operator-input boundary — the route.

I wrote a test asserting *why* the library needs no upper bound, including that
`dropAfter` past the end still means "no drop", so a future author reading only
the route fix doesn't "complete" it in the library. That turns "I didn't change
that one" into a recorded decision.

Two smaller details. `Number.isSafeInteger`, not `isInteger`:
`Number("99999999999999999999")` is `1e20`, which `isInteger` reports true for
while no longer being the value typed. And the `TOTAL_TOKENS` boundary is
inclusive on purpose — resuming past the last token is reachable from a clean
run that dropped on the final token, and getting that off by one would turn a
real resume into a spurious replay.

Every test asserts frame counts and event kinds rather than exceptions, because
the `999999` case produced a perfectly valid 200 and an exception-shaped
assertion would have missed the whole defect.

One hunt was declined and is recorded so it isn't refiled: `parseSseFrame`
trims the `data` value as well as the event name, which *would* lose a
meaningful space if a JSON payload were split across `data:` lines at one. All
four in-repo routes emit `JSON.stringify(...)` on a single line, so it is
unreachable — consistent with the earlier "declined as churn" note on the same
seam.

## 2026-08-20 — the page claimed 50/50 while a two-click session is 80/20 (#100)

D-010's rationale has always stated the property correctly: first-click bias
keeps the happy path visible, and *subsequent* clicks split 50/50. Every
restatement but one dropped that qualifier — the lib header, an inline comment,
two places in the README, two in `docs/architecture.md`, and the copy a visitor
actually reads at `app/optimistic-rollback/page.tsx:29`. One UI label 28 lines
below the wrong one, on the same page, had it right.

Measured over the five demo ids, clicks 2..11 give 25/25 and clicks 2..1001
give 2500/2500 — exactly even, so the hash half is genuinely exact. The
unqualified claim was falsified entirely by the deliberate first-click bias
that `decide` introduces a few lines below the comment asserting it. Clicks
1..2 give 8/2: a visitor who clicks twice sees the rollback 20% of the time,
while the file's own header says that path "can't be a rare event; it has to
fire reliably enough for a casual visitor to observe it".

The repo's own test already knew. It is named "approximately 50/50 over the
demo ids × clicks 2..200 (first-click bias excluded)" — it had to exclude click
1 to pass, and nothing propagated that back to the prose. When a test name
carries an exclusion, the exclusion is evidence that an unqualified claim is
false somewhere else.

The second half of the issue was `decisionSplitOver` guarding `clickRange` and
not `ids`, so the vacuous `{0, 0}` its own guard exists to prevent was still
reachable through the other operand of the same product. That guard's comment
states the reason and it applies verbatim. Degenerate *elements* were already
covered — `[""]` and `[null]` both throw from `decide` — so it was only the
empty container that slipped through, the same container-versus-element split
as chunking-strategies-lab's metric-map guards.

The lock matches a *family* of qualifier phrasings rather than one exact
sentence, because pinning one string would just move the drift somewhere else,
and it also asserts D-010's own wording still contains the phrase it is
measuring against.

Two process notes, both from the lock catching me. Its first regex matched
"first click" with a space, and I had written "first-click" with a hyphen in
my own new docstring — so it flagged a line that was actually correct. Run a
new doc lock against the docs you just wrote, not only the ones you are fixing.
It also flagged the `clickRange` guard comment, which mentions a "50/50 split"
property test — a meta-reference, not a claim about the oracle. Rather than
build an exemption mechanism I reworded the comment. A lock with no exemptions
stays trustworthy.

I deliberately did not change the split. The first-click bias is intentional
and D-010 records why; the defect is the description, not the behaviour.
Whether a casual visitor *should* see the rollback more often than 20% is a
product question about the demo's teaching value, and it would be a D-010
revisit with its own issue.

**Why this work, this session:** the static `priority:high` queue was globally
empty; this came from reading `lib/optimistic-decision.ts`'s prose claims and
running them.

**Open questions / blockers:** none new. `#97` and `#82` remain JT-gated
decision-revisits.

**Next session:** the numeric query-param sweep is closed here — `#98` fixed
`error-recovery`'s `?checkpoint=`, and the other four API routes read no
numeric params at all.

---

## 2026-08-21 — asking for a slow stream and getting an instant one (#102)

The three mock streamers share a validation helper that rejects a delay of
`NaN`, `Infinity`, or a negative number. Its comment explains why it exists: the
32-bit `setTimeout` clamp. It names the hazard correctly and then guards only
half of it.

A *finite* delay of `2**31` or more hits exactly the same clamp. Measured across
all three streamers: `2**31 - 2` and `2**31 - 1` are honoured and the stream
stays pending; `2**31`, `2**32`, `5e9` and `MAX_SAFE_INTEGER` all deliver their
first event in nought to four milliseconds. The cliff is precisely `2**31 - 1`.

What makes this worse than a plain range bug is the direction. You ask for a
very slow stream and you get an instantaneous one — the opposite of the request,
with no error. `Infinity` at least failed loudly. `5e9` quietly dumped every
token at once, which is the same broken-demo symptom the guard's own comment
attributes to `NaN`. Node does print a `TimeoutOverflowWarning`, but to stderr,
where the demo UI never sees it.

Then there's the half I nearly missed. The helper checks `baseDelayMs` and
`jitterMs` separately, but what actually reaches the timer is
`baseDelayMs + floor(rand() * jitterMs)` — an operand the guard never inspects.
So two individually legal options can combine into an illegal delay. With a base
of 2147483598 and a jitter of 200, eleven runs in twelve collapsed to a
millisecond and the twelfth honoured the delay. The same configuration works or
breaks depending on a random draw, which is considerably harder to diagnose than
something that always fails. The fix bounds the sum at construction, since
`baseDelayMs + jitterMs` is the most it can ever reach.

The most interesting part was that the guard's stated reason turned out to be
factually wrong. It claimed `Infinity` "hung forever on the first sleep (~24-50
day setTimeout clamp)". It doesn't — Node clamps `Infinity` to one millisecond,
exactly like `NaN`, and it fires immediately. I've corrected the comment rather
than deleting it, and recorded the measurement, because the wrong belief is
plausibly the reason nothing capped delays from above: if you think large values
are slow, putting a ceiling on them never occurs to you. A false reason produces
a wrong scope.

This also corrects a portfolio note. The `setTimeout` clamp was recorded as
swept, with this repo marked clean — but that sweep covered the two retry
helpers, and the streamers' validation family was never in scope. When a note
says a repo is clean for a class, the question is which files the sweep actually
enumerated.

`checkpoint-stream.ts` genuinely isn't affected, and the test file says so:
its validator guards integer indices into an event sequence, not delays, so
they never reach a timer.

Two probe mistakes worth remembering. My first timing run passed a `seed`, and
`mockTextStream` skips the sleep entirely when a seed is set — so every value
came back instant and looked clamped, including ones that aren't. The tell was
that the supposedly-clamped row produced no overflow warning. And my first draft
of the tests used `expect(() => stream(opts)).toThrow()`, which never fires:
these are async generators, so the validator doesn't run until the first
`next()`. Thirty-nine tests failed vacuously in the wrong direction before I
noticed the repo already had the right idiom in its own suite.

---

## 2026-08-24 — Issue #104: `CAPTURE_PACE_MS=1e3` silently meant 1 ms

**What got done.** `scripts/capture_demo.ts::readOptions` reads three
environment variables. None of them was covered — the smoke test validates
`TIMELINE` against `app/page.tsx` and could not reach option parsing at all,
because `readOptions` wasn't exported. The script's own header docstring claimed
"smoke test passes 0" for `CAPTURE_PACE_MS`; nothing in `test/` referenced it.

**The pace guard named a contract its parser didn't enforce.** The message has
always said "must be a non-negative integer", and `Number.parseInt` enforces no
such thing — it consumes a numeric *prefix* and discards the rest:

```
"250"     -> 250      "1e3"    -> 1        <- 1000x low
"250abc"  -> 250      "1_000"  -> 1        <- 1000x low
"+250"    -> 250      "12,000" -> 12       <- 1000x low
"  250 "  -> 250      "0x10"   -> 0
                      "3.9"    -> 3
```

`1e3` and `1_000` are the two natural ways to write "one thousand
milliseconds", and both became **1 ms** — in the one knob whose entire job is to
slow each interaction down enough to be visible on camera. The capture races
through every stop and produces unusable footage, with nothing in the log to say
the value was misread. Worth noting the paired `Number.isFinite` check could
only ever have caught `NaN`, since `parseInt` cannot return `Infinity`; it read
as broader than it was.

**`??` does not default an empty string.** `process.env.X ?? "default"` defaults
on `null`/`undefined` only, so `CAPTURE_BASE_URL= npm run capture` — and an
empty line in a `.env` file — passed an empty string straight through:

```
""                 TypeError: Invalid URL
"localhost:3000"   TypeError: Invalid URL     <- missing scheme
```

**The lateness was the harm, not the bad value.** That `TypeError` was thrown
from inside `runCapture`'s loop — *after* `chromium.launch()` and
`context.newPage()`, so a browser was live and a video recording context was
open — and the message named neither the variable nor the script. Meanwhile the
pace guard two feet away already demonstrated the right shape: throw in
`readOptions`, before any of that. `CAPTURE_OUT=""` failed the other way,
silently: `dirname("")` is `"."`, so Playwright recorded into the repository root
and the closing line read `move/rename it to ` with nothing after it.

**This class was already fixed one directory over.** `lib/anthropic-stream.ts`
handles exactly this for `ANTHROPIC_MODEL`, and its comment states the reason in
terms that transfer verbatim: "The pre-#32 shape passed an empty string verbatim
to the SDK, which surfaced as an API error rather than failing loud against the
local fallback." #32 was scoped to `lib/`; `scripts/` was never swept.

**Two deliberate choices.** The URL is *classified* by attempting the parse
rather than pattern-matched, because the set of things `new URL` accepts as a
base is exactly what matters and reimplementing it would carry false-positive
risk on working setups where asking carries none — the same posture as
rag-production-kit's `--host` classifier. And the accepted rows (`"250"`,
`"  250  "`, `"0"`, `"+250"`, `"1000"`) are pinned alongside the rejected ones: a
value-domain fix that over-rejects is a different bug, not a stricter one.

**Why this was prioritized.** `nextjs-streaming-ai-patterns` is a priority-tier
repo (D-009) whose entire open queue is JT-gated decision-revisits, so the issue
came from a firsthand probe. `scripts/` was the surface the last six PRs did not
touch.

**Tests.** 46 new (`test/capture-demo-options.test.ts`); 21 fail against a
narrowed revert of the three behaviours. Suite 473 → 519 green, `tsc --noEmit`
clean, `eslint` clean.

## 2026-08-25 — #95's CRLF fix had reached half the SSE clients (#106)

**What got done.** `#95` fixed the SSE separator scan in `pumpSseFrames`: the
spec ends a line with any of `\r\n`, `\n`, or `\r`, so the blank-line event
separator has three byte forms and `indexOf("\n\n")` finds exactly one. Four
client components read SSE, and only two used the pump. The other two carried
their own pre-`#95` loop, and on a CRLF- or CR-framed body they discarded the
entire stream — zero frames, no throw, no log. `streaming-text-client` then
called `setStatus("done")` on an empty pane; `error-recovery-client` fell
through to "connection closed mid-stream" and resumed forever against a stream
that was arriving fine.

**How it was found.** The import lines. Two clients import `isAbortError`,
`parseSseFrame` *and* `pumpSseFrames`; two import `parseSseFrame` only. A shorter
import list from a shared module is a cheap, high-signal tell that a site missed
a centralization. `pumpSseFrames`'s own comment then confirmed the scope: it says
normalizing there "makes **the two layers** agree", and there are four clients.

**A design call changed mid-plan, and why.** The issue proposed migrating both
components onto `pumpSseFrames`. Reading `error-recovery-client` closely showed
that is the wrong shape: it returns from *inside* frame handling on `done` and
`error` events, and wraps each individual `reader.read()` in its own `try` to
tell a network drop from an SSE error frame. The pump has no early stop. What is
actually duplicated is not the read loop but the **framing rules**, so those
moved into `createSseFramer` and the pump became a thin loop over it. A component
that needs its own control flow is not a reason to copy the rules.

**Shipped a lock, not just a fix.** A test asserts that no file under
`components/` scans for a separator itself — the check that would have caught
this when `#95` shipped. It strips comments before matching, because the new
explanatory notes quote the old shape, and a lock must not trip on the prose
explaining its own fix.

**Reachability, said plainly in the issue.** Every route in this repo emits
`\n\n`, so the shipped demo never triggers it. That was equally true when `#95`
was filed and fixed. The argument here is not a new hazard; it is that a fix
already judged worth making landed at two of four sites.

**Open questions.** Filed as #107, not worked: `parseSseFrame` trims each `data:`
line *before* accumulating them, so a JSON payload split across two lines at a
space reassembles without it — and still parses. Its docstring contains both
halves of that contradiction, and the trim's stated reason is declared
non-load-bearing by `pumpSseFrames`'s own comment.

**Tests.** 60 new (`test/sse-framing-parity.test.ts`) over 8 bodies × 4 read
chunk sizes, anchored to the measured pre-fix counts. Verified non-vacuous twice:
appending one re-inlined `indexOf` line to a component fires the lock, and
removing only the normalization regex turns 9 of 60 red. Suite 519 → 579 green,
`tsc` clean, prettier clean.

## 2026-08-26 — a trim that ran before the join it was meant to survive (#107)

**What got done.** `parseSseFrame` trimmed every field value *before*
accumulating `data:` lines, so a payload split across two lines lost whitespace
at the seam — and the corrupted result still `JSON.parse`d cleanly, so a text
delta just quietly lost a space. `event` keeps the full trim; `data` now strips a
single trailing `\r` and nothing else.

**This was a filed-but-unworked followup from the previous run,** not a fresh
hunt. The repo had zero `priority:high` issues, two JT-gated decision-revisits,
and one actionable `priority:med` — which a previous session had already measured
in full. Check the followup list before hunting.

**The defect shape: a per-item normalizer that runs before a join.** The trim ran
per line, and the separator-less join is precisely what reassembles a split
payload, so the normalizer ate exactly the bytes at the seams. Worth asking of
any per-element cleanup: are these elements later concatenated?

**The docstring carried both halves of the contradiction.** The trim is justified
by a rule about `event` ("under CRLF framing the event name kept its `\r`"). Two
paragraphs later, joining without a separator is justified as "what makes a JSON
object split across `data:` lines reassemble, so it is preserved deliberately".
A rule stated for one field and applied to all fields is the whole bug.

**The strongest moment of the run: a pre-existing test blocked me, and its own
name argued for my change.** The test is called *"strips exactly one space,
leaving any others in the value"*. Its comment's first sentence says "one
optional space is part of the framing, the rest is payload". Then a parenthetical
concedes "the trailing trim then removes it here", and the assertion expects
`"x"` rather than `" x"` — the opposite of its own title. I posted a correction
on the issue before committing, named the edited assertion explicitly, kept the
original wording, and added a note about what changed rather than rewriting it to
look like it had always said that. And the anti-vacuous revert turns *that very
assertion* red along with twelve others — which is what shows the edit is
load-bearing rather than cosmetic. If you must edit a pre-existing assertion,
show it going red under the revert.

**Narrow a guard to its stated reason; don't delete it because the reason is
covered elsewhere.** The trim existed for CRLF, and `#106` moved normalization
into `createSseFramer`, whose own comment says that "keeps the parser's `\r` trim
harmless rather than load-bearing". I could have deleted it outright. Keeping a
single trailing-`\r` strip costs nothing and still protects a direct caller of
the exported parser who never went through the framer.

**One behaviour change, stated rather than hidden.** `data:` followed by three
spaces used to trim to `""` and now yields `"  "`. I checked all four consumers:
each guards with `!dataLine` and then `JSON.parse` inside a try/catch that
returns on failure, so the frame is skipped either way — by the catch instead of
by the emptiness guard. No in-repo route can emit that shape. Pinned as its own
test.

**Tests.** 28 new. Restoring the old per-line trim turns 13 of 43 red across both
files, with 0 controls red: the mid-word split, the single-line trailing space,
every `event keeps the full trim` row, and every canonical in-repo lock stay
green. Suite 579 → 607, tsc and eslint clean.


## 2026-08-27 - #110: a correct comment above an incorrect line

`#102` capped the mock streamers' delays because `setTimeout` clamps anything
over `2**31 - 1` to one millisecond: ask for a deliberately slow stream, get an
instantaneous one, with a warning on stderr as the only clue. It also added a
guard for the *sum*, and the comment it wrote is exactly right - `setTimeout`
receives `baseDelayMs + floor(rand() * jitterMs)`, not either field alone, so
both per-field checks can pass while the value reaching the timer is over the
clamp.

The line under that comment computed something else. The guard defaulted an
omitted field to `0`; the generator defaults it to 30 (80 and 40 in the JSON
streamer). So with `jitterMs` left out, the guard checked `MAX + 0` and passed,
and the generator computed `MAX + floor(rand() * 30)` and overflowed on
twenty-nine draws in thirty. Measured on the real modules, a requested delay of
about 24.8 days delivered its first event after three milliseconds. A correct
comment above an incorrect line is the hardest kind to see, because reading the
comment satisfies you.

The test file written for that guard could not have caught it. Every boundary
case in it passes *both* fields - and with both present, `?? 0` and `?? 30` are
the same expression. The one shape that separates them is an omitted field, and
that is the shape it never constructs. This is the chunking-lab lesson one step
over: an invariant test is only as wide as its input types, and "omitted versus
present" is a shape, not a value.

So the acceptance signal was that every pre-existing test passes unchanged, with
no assertion edited. If the fix had moved a boundary for a config that already
passed, it would have been the wrong fix.

The defect was one quantity with two spellings, so the fix gives it one. Each
module declares its defaults once and hands the same identifier to the guard and
to the generator, which is a stronger property than "both were updated" - they
cannot disagree at all now. The rule itself moved into one shared module,
justified by the defect rather than by taste: three byte-identical copies, all
wrong the same way, is what three copies does. The other triplicated helpers in
those files stayed put, because they are duplicated but not wrong, and a bug fix
is not the place to smuggle a refactor.

Two documentation locks fired along the way and both were right to. The new
module had to be named in the architecture doc, and the doc's symbol allow-list
needed `setTimeout` and `TimeoutOverflowWarning` admitted - a list with a hard
pin on its exact contents, so widening it had to be a reviewed edit. That is the
second repo today where a symbol lock needed a runtime name let in.
