# Core Decisions

Strategic decisions for this repo, with reasoning. Append-only — superseded decisions are marked, not removed.

## D-001 — Scope locked to portfolio handoff §2 (2026-05-10)
**Decision:** Scope of this repo is fixed by the portfolio handoff document, section 2.

**Why:** The handoff spec was deliberated; ad-hoc scope expansion within a session is the failure mode this prevents.

**Alternatives considered:** None — this is a baseline.

**Reversibility:** Expensive. Scope changes require a deliberate revisit and a new decision entry.

**Related issues:** —

## D-002 — One Next.js app at repo root, one page per pattern (2026-05-15)
**Decision:** The repo is a single Next.js 15 App Router app at the repo root. Each pattern lives in its own subdirectory under `app/<slug>/`. There are no per-pattern subpackages, no monorepo workspaces, no separate apps.

**Why:** This is a *patterns repo*, not a framework or a monorepo. The success criterion is a developer can copy one pattern's page + its components + its lib helpers into their own Next 15 app in under 10 minutes. A subpackage layout would force them to reason about two `package.json` files; a monorepo would force a workspaces tool dependency. Both work against the "copy one pattern in 10 minutes" goal.

**Alternatives considered:**
- Per-pattern subpackages — rejected because the patterns share dependencies (Next, React, Tailwind) and shouldn't fork them.
- Separate apps per pattern — rejected because navigation between patterns is part of the demo (the hub page links them all).
- Examples in Storybook — rejected because Storybook adds a build pipeline that's irrelevant to the patterns themselves.

**Reversibility:** Cheap. Future split into a workspaces monorepo is purely additive.

**Related issues:** #1, #2

## D-003 — Every demo runs without `ANTHROPIC_API_KEY`; mock fallback is mandatory (2026-05-15)
**Decision:** Every demo page in this repo must render meaningful streaming output without an Anthropic API key. When `ANTHROPIC_API_KEY` is unset, `lib/anthropic-stream.ts` falls back to `lib/mock-stream.ts` — a deterministic committed fixture with realistic per-token jitter. The page surfaces which mode is active in the UI so the operator isn't confused about whether they're seeing "real" model output.

**Why:** The repo's primary audience is developers evaluating it without first signing up for an API. If the demos require a key, the bounce rate from "first 30 seconds on the page" → "set up an account" is high enough that the patterns lose their teaching value. The mock fallback is also useful for code review (PR reviewers can run the demo locally) and CI (the test suite never needs a key).

**Alternatives considered:**
- Require key for demos — rejected because of the audience friction above.
- Recorded responses only (no live mode) — rejected because the live mode is part of the value (some patterns, especially future error-recovery, depend on live behavior).

**Reversibility:** Cheap. The mode switch is one function (`getStreamMode()` in `lib/anthropic-stream.ts`).

**Related issues:** #1

## D-004 — Source displayed alongside each demo is read from disk at request time (2026-05-15)
**Decision:** The source code shown next to each demo is the actual source file on disk, read by a Server Component (`components/source-pane.tsx`) at request time and syntax-highlighted server-side via shiki. There are no copy-pasted code blocks in JSX strings, no MDX with inline code, no build step extracting snippets.

**Why:** The most common failure mode for "code alongside live demo" is the displayed code drifting from the actual code as the demo evolves. Reading from disk makes drift impossible by construction — a refactor anywhere in the imported file is reflected in the displayed source on the next request. This costs one `fs.readFile` per request per displayed file, which is negligible.

**Alternatives considered:**
- Code blocks in JSX strings — rejected because they rot.
- MDX with inline code blocks — same problem, plus pulls in MDX as a dep.
- Build step extracting snippets to JSON — rejected as overengineered for the size of this repo.

**Reversibility:** Cheap. A future move to MDX or per-file build extraction is straightforward.

**Related issues:** #1

## D-005 — Streaming uses route handler SSE + client reader, not pure RSC streaming (2026-05-15)
**Decision:** The streaming text pattern (and every future stream pattern in this repo) is implemented as a Next.js route handler returning `text/event-stream` SSE plus a small Client Component that reads `response.body` as a `ReadableStream` and progressively renders. Pure-RSC streaming (a Server Component yielding tokens via Suspense) is rejected.

**Why:** React 19 + Next 15 do not provide a stable zero-JS pattern for per-token-in-the-browser streaming text from a Server Component. Server Components stream their JSX progressively via Suspense boundaries, but each boundary resolves once with its full content — there's no public API for a Server Component to yield a partial string and have the browser re-render in place without client JS. The honest answer is therefore that server-side streaming happens in the route handler and browser-side incremental rendering happens in a Client Component. Both are required for true per-token streaming.

**Alternatives considered:**
- Pure RSC with Suspense boundaries — rejected because each boundary resolves once with its full content; the user sees a loading skeleton then the full text, not progressive tokens.
- `ai` SDK's `streamUI`/`createStreamableValue` — rejected because adding the `ai` SDK dependency just for streaming primitives is overkill when the pattern is ~100 lines of vanilla code.
- WebSockets — rejected because the issue scope explicitly says "without WebSockets" and SSE is the better fit for one-direction streaming anyway.

**Reversibility:** Cheap. If a future React/Next release lands true per-token RSC streaming, swap the implementation under the same `<StreamingTextClient />` interface.

**Related issues:** #1, #2

## D-006 — Tool-use streaming uses the same SSE frame format as text-only (2026-05-16)
**Decision:** The `/api/tool-use` endpoint emits SSE frames using the same shape as `/api/stream-text` (D-002 + D-005), just with additional `event:` types: `text_delta`, `tool_use_start`, `tool_use_delta`, `tool_use_stop`, `tool_result`, `message_stop`. The wire format is one protocol for all streaming patterns in this repo.

**Why:** A single SSE protocol means the client-side renderer unions over event types and dispatches in one place. A future pattern that adds `citation_delta` or `reasoning_block` events just adds an `event:` name; the transport, the framing, and the abort semantics stay identical. Splitting into separate endpoints (or a WebSocket for tool-use-only) would force the client to maintain two parallel readers and diverge over time.

**Alternatives considered:**
- Separate JSON endpoint for tool-use — rejected: would force a non-streaming render path for tool calls, which exactly defeats the point of this repo.
- WebSocket for tool-use-only — rejected: inconsistent transport with the text pattern, no benefit since HTTP/2 streaming covers the use case.

**Reversibility:** Cheap. The wire-format choice is one constant in the route handler and a switch statement in the client.

**Related issues:** #2

## D-007 — Interrupt is `AbortController` end-to-end (2026-05-16)
**Decision:** The tool-use UI's "interrupt" button calls `AbortController.abort()` on the same controller it passed to `fetch('/api/tool-use', { signal })`. Next.js exposes the client's abort on `req.signal`; the route handler passes it into `mockToolStream({ signal })`; the streamer checks `signal.aborted` at every yield boundary and yields a final `message_stop` with `stop_reason: "interrupted"` before returning. One `AbortSignal` propagates through three layers.

**Why:** `AbortController` is the standard browser primitive for cancellation. Reusing it end-to-end means no custom token/handshake/cancellation-id system to maintain, and the same primitive a developer already uses for `fetch` timeouts also handles interrupt for streaming. The clean-transcript guarantee (an explicit `message_stop` rather than a broken-pipe error) is what makes the UI feel deliberate rather than crashed.

**Alternatives considered:**
- Server-side cancellation token via a separate channel — rejected: extra surface for the same outcome.
- WebSocket close — rejected: same as D-006; we're not on WebSocket.
- Separate "cancel" endpoint by stream id — rejected: forces server-side state tracking we don't otherwise need.

**Reversibility:** Cheap. The abort plumbing is a single `signal` parameter through three layers; replacing it is mechanical.

**Related issues:** #2


## D-008 — Partial-JSON parser is a dep-free in-repo implementation, not a vendored npm package (2026-05-17)
**Decision:** The partial-JSON parser used by the `/partial-json` pattern (#3) is `lib/partial-json.ts`, a ~120-line dep-free state machine written in this repo. We do not import `partial-json`, `json-parse-stream`, or any other vendored library for this functionality.

**Why:** The repo's mission per the portfolio handoff §2 is "reference patterns for AI features in Next.js" — readers come here to learn the *pattern*. A vendored library hides exactly the technique the page is supposed to teach: how to walk a streaming buffer, track per-frame state, decide what to drop versus keep, and produce a syntactically valid repair. The source pane shows the actual parser alongside the demo (D-004); a black-box import would make the source pane a thin wrapper that doesn't teach anything. Secondary motivation: zero runtime deps for the demo path stays consistent with `mock-stream` and `mock-tool-stream` for the other patterns.

**Alternatives considered:**
- Vendored `partial-json` npm package — rejected: hides the pattern, adds a runtime dep for a demo page that's specifically about explaining the technique.
- Vendored `json-parse-stream` — same issues.
- Ad-hoc regex-based repair (no state machine) — rejected: fragile at the edges that matter most (escaped quotes inside strings, mid-token primitives, distinguishing a key in `key` state from a value in `value` state). The committedAny + per-frame state machine is the simplest correct version.

**Reversibility:** Cheap. The parser is one file with a stable `parsePartialJson(buffer) → { value, isComplete }` interface and 20 tests pinning the semantics. Swapping to a library later is one import change.

**Related issues:** #3

## D-010 — Optimistic-rollback demo uses a deterministic decision oracle keyed by `(id, click_count)` (2026-05-18)

**Decision:** The `/optimistic-rollback` pattern's commit/rollback split is driven by `lib/optimistic-decision.ts`'s `decide({ id, click_count })` — a pure function that returns a deterministic `{ ok: true, improved_name } | { ok: false, reason }`. First click on each item always commits (happy path leads); subsequent clicks split exact 50/50 via an FNV-1a hash low-bit.

**Why:** The rollback path is the *load-bearing UX* for this pattern. If it fires randomly, three things break: (1) tests can't pin the rollback branch without flake, (2) a visitor demoing the page might never see a rollback in a short session and conclude the feature is half-built, (3) when a reviewer asks "what does the rollback look like?" there's no reproducible repro to point at. A deterministic oracle keyed by inputs the user supplies (the id they click, the count of clicks) gives every branch a stable address: the property test in `optimistic-decision.test.ts` proves the 50/50 split holds over 5 × 199 = 995 inputs, and a reviewer can hit "improve" twice on `untitled-4.txt` and observe a specific rolled-back outcome. The first-click bias is a small UX courtesy — visitors see the optimistic-commit pattern work *before* they see it roll back.

This is the same posture as the earlier deterministic-demo decisions: D-003 (the mock streamer is committed bytes, not network), D-005 (the streaming pattern uses a route handler + client reader, not a magic abstraction), D-008 (the partial-JSON parser is dep-free in-repo so the technique is visible). Each tells the same story: the demo is real source code running deterministic logic, not a closed-loop "trust me" black box.

**Alternatives considered:**
- `Math.random()` at the route handler — rejected: the rollback path becomes flaky in CI and unreproducible in dev. A reviewer can't ask the demo to show them a specific outcome.
- Seeded RNG with a single static seed — rejected: every click on every item gives the same outcome forever. The demo loses its "click again, see what happens" interactivity.
- Seeded RNG keyed only by `id` — same as above: same item always succeeds or always fails. Visitors never observe the *change*-of-outcome the pattern is about.
- Round-robin per `id` (success, then fail, then success, ...) — rejected: predictable in a way that doesn't reflect the LLM-disagrees-sometimes UX the pattern teaches.

**Reversibility:** Cheap. The oracle is one ~80-line file. Swapping it for a network round-trip to Anthropic is a one-export change.

**Related issues:** #4

## D-011 — Error-recovery checkpoints are token-position integers, not opaque server-state blobs (2026-05-18)

**Decision:** The `/error-recovery` pattern's checkpoints are simple 1-indexed integers carrying the index of the most-recently-emitted text token. The wire shape is `{ kind: "checkpoint", last_token: N }`. The client records the latest `last_token` it has seen and, on disconnect, reconnects with `?checkpoint=N` in the query string. The server resumes by passing `startAfter: N` to the generator — which silently skips the first N tokens.

**Why:** An integer-index checkpoint lets the *whole protocol* be stateless. The server doesn't need a per-session map; the generator is a pure function of `(startAfter, dropAfter)`. The drop branch stays deterministic — every first request drops at token 12, every resume request completes — which is the load-bearing property for an observable demo (a visitor sees the resumed pill on the first run, not by chance). The shape also composes naturally with the existing SSE event format from `streaming-text` (D-005): `data: {text}` for text, `data: {last_token: N}` for checkpoints, no protocol divergence to learn.

**Alternatives considered:**
- Opaque cursor strings (`{ checkpoint: "abc123..." }`) — rejected: forces a server-side state map keyed on the cursor; the route handler must look up "what does abc123 mean for this client?" before resuming. Defeats the deterministic-drop property because state is now a function of past requests, not of current inputs.
- Per-session backing store (Redis / database) — rejected: overkill for a demo that's supposed to run on a fresh clone without infra. The pattern's teaching point is the *protocol*, not the durability layer.
- Client-side hashing of received text — rejected: brittle. Client and server tokenization can diverge under any future refactor of the fixture; a hash mismatch leaves the resume request without an answer.

**Reversibility:** Cheap. The wire format is one integer field; swapping it for an opaque cursor would touch three files (`lib/checkpoint-stream.ts`, `app/api/error-recovery/route.ts`, `components/error-recovery-client.tsx`) and the tests that pin the shape.

**Related issues:** #5

## D-012 — `scripts/capture_demo.ts` is the demo's source of truth; binary recording is a separate follow-up (2026-05-21)

**Decision:** The 60-second demo for this repo is engineered as a deterministic Playwright driver script (`scripts/capture_demo.ts`) plus a vitest smoke test (`test/capture-demo-smoke.test.ts`) that pins the tour's slugs against `app/page.tsx`'s `PATTERNS` array. The actual `docs/demo.{webm,mp4,gif}` binary commit is split into a separate issue (#16) that runs the script and commits its output. The script lands now; the binary lands when someone has 30 min and the local tooling installed.

**Why:** What makes the demo durable is reproducibility — a pattern UX changing must not silently leave the recording lying. The Playwright script + the smoke test together are the reproducibility mechanism: the script encodes the click sequence; the smoke test fails if a slug drifts away from the homepage `PATTERNS` array or a `page.tsx` is removed. A committed binary without that infrastructure is a museum piece — it rots on the first pattern rename. So the script is the load-bearing artifact and the binary is downstream. Splitting also keeps this PR's diff focused on engineering CI can verify, and lets the binary step (which requires `npx playwright install chromium` ~150 MB, a running dev server, and `ffmpeg` for size optimization) ride to a separate operational session that doesn't need to fit inside a remote autonomous run. Pattern mirrors what landed today across `embedding-model-shootout`, `chunking-strategies-lab`, `vector-search-at-scale`, `python-async-llm-pipelines`, and `agent-orchestration-platform`.

**Alternatives considered:**
- Record the video inside this PR — rejected: requires Playwright browsers + ffmpeg + dev-server lifecycle to be orchestrated during a remote autonomous session; not reproducible in CI; and the actual artifact is a binary, which makes the PR's diff opaque to reviewers.
- Ship only the binary, no script, recapture by hand on each pattern change — rejected: the click sequence becomes oral tradition; the recording silently goes stale when a pattern UX shifts; no test surface to catch drift.
- Use a screen-recorder macro instead of Playwright — rejected: no repository-of-truth for the tour; no smoke-testable shape; first pattern rename breaks it without warning.

**Reversibility:** Cheap. If we later want the binary committed in this same PR's pattern, it's one `npm run capture` + `git add docs/demo.webm` + README embed away. The decision documents the *split*, not a hard line against binaries in the repo.

**Related issues:** #12, #16

## D-013 — Every SSE read path flushes its `TextDecoder`, even though it changes no frame today (2026-09-01)

**Decision:** All three SSE read paths — `pumpSseFrames`, `streaming-text-client`, `error-recovery-client` — make the argument-less `decoder.decode()` call before flushing the framer. A structural lock in `test/sse-decoder-flush.test.ts` requires it of any file that decodes with `{ stream: true }`.

**Why:** `TextDecoder` with `{ stream: true }` holds back a trailing incomplete UTF-8 sequence, waiting for the rest of it. If the body ends mid-codepoint those bytes are never emitted at all; the argument-less call releases them as `U+FFFD`. All three paths made the streaming call and never the flushing one (#115).

The honest case for the change is layered, and the measurement is what makes it a decision rather than a reflex. At the decoder the difference is real: `"data: café"` cut mid-`é` decodes to `"data: caf"` streamed and `"data: caf�"` flushed. At the *frame* the difference is **nil**. Across eight bodies covering LF, CRLF and CR framing, lone-CR terminators and multibyte payloads, times every byte-truncation of each, times read-chunk sizes {1, 2, 3, 5, whole}, the frames emitted are identical with and without the flush — zero differing cases. The held bytes only exist when the stream ended mid-codepoint, which means the framer is holding an unterminated tail, which `flush()` deliberately drops.

So this is not a bug fix and is not presented as one. It is adopted because it costs one line per path; because the exhaustive equivalence proves it *safe* rather than merely hoped-safe; and because #97 is open about whether a truncated tail should surface as an error rather than being silently dropped. If #97 ever says yes, `U+FFFD` is the evidence that bytes were lost — and it has to have survived to be it. The equivalence assertion doubles as the tripwire: the day `flush()` starts emitting the remainder, it goes red and points at this decision.

One adjacent hazard was checked and is not a bug: `error-recovery-client` constructs its `TextDecoder` inside `run()`, so each resume gets a fresh one and no held bytes leak from an aborted stream into the next.

**Alternatives considered:**
- Leave it and wait for #97 — rejected: that leaves three files to remember at a moment when whoever decides #97 will be thinking about framing, not decoding.
- Flush only in `pumpSseFrames` — rejected: that is exactly the partial-adoption shape #114 had just finished fixing in this same seam.
- Also emit the framer's unterminated remainder — rejected: that is #97's question, and the `flush()` comment already owns it.

**Reversibility:** Cheap. One line per read path and one structural test.

**Related issues:** #115, #114, #97

## D-014 — `stripComments` stays line-suffix-dropping; its limits are declared *and measured*

**Date.** 2026-09-14 · **Reversibility.** Cheap · **Issues.** #127, #126, #123

**Decision.** `stripComments` remains what it is — two regex replacements that drop
everything after the first `//` not preceded by `:`. It is not taught to track
string or regex state. Its limits stay *declared*. What changes is that they are
now **measured** by a repo-wide census rather than asserted unreachable.

**Why.** The helper runs inside every structural lock, so it has to stay cheap and
predictable, and a helper that *pretends* to lex is worse than one whose limits are
written down: a partial lexer is wrong in cases nobody enumerated, while a declared
limit is wrong in cases anybody can read. That argument was already in the
docstring and it still holds.

What did not hold was the sentence next to it: "Neither is reachable in this repo."
That claim decayed without anyone re-deciding anything, and the reason is worth
recording, because the claim was not careless. Its two reachability probes really do
come back empty — but they run over `readSourceFiles()`, whose population is
`SOURCE_DIRS` (`lib` + `components` + `app`). The structural locks in
`test/strip-comments.test.ts` pass **test** files through `stripComments`, and every
truncation in the repo is in a test file. The probes guarded the corpus that is not
affected and left the affected one unscanned. The defect was the scope of the
population, not the reasoning.

There is also a third case that was never declared at all: a regex literal whose
body ends `\*\/` before its flag group puts two adjacent slashes before the closing
delimiter, and the preceding backslash satisfies the `[^:]` URL-scheme guard. That is
`stripComments`' own definition line.

**Measured.** 71 files across `lib`, `components`, `app`, `test`, `scripts`: 27
truncations before this change, 26 after rewriting `test/readme-patterns-table.test.ts`'s
`/^\//` to `/^[/]/`. By cause: 22 string-literal, 4 regex-literal. **Zero** in
`lib`/`components`/`app`/`scripts`, so the locks over shipped source are unaffected
today — and the census makes that emptiness an enforced property rather than a
current fact.

**Alternatives considered.**
- *Teach `stripComments` regex and string state.* Rejected: it is the lexer the
  docstring correctly refuses, and it would run inside every lock.
- *Drop the whole line instead of the suffix.* Rejected: a lock stated as "must be
  PRESENT" would newly fail on 26 lines of real code.
- *Refuse to strip a file containing a truncation.* Rejected: turns a silent
  weakening into a hard stop on files that are correct today.
- *Rewrite all 26 truncating lines.* Rejected: most are in `strip-comments.test.ts`,
  where a `//` inside a string **is** the deliberate fixture; rewriting them would
  destroy the tests.
- *Keep asserting unreachability over a wider corpus.* Rejected: an emptiness
  assertion that is already false 27 times is not widened, it is replaced by a count.

**Revisit when** a `lib`/`components`/`app` file ever enters the census. The census
has a separately-named arm for exactly that slice, so it fires with its own message,
and the line-dropping/refusal tradeoff gets reconsidered with a real instance in hand
rather than in the abstract.

**Explicitly not decided here.** Whether a structural lock should *refuse* a file it
cannot strip cleanly, rather than silently reading a truncated one.

---

## D-015 — the population is derived; the literal list is a floor, not the population

**Date.** 2026-09-25 · **Issue.** #134 · **Reversibility.** cheap

**Decision.** `strip-comments.test.ts` derives the "neither `test/` nor
`SOURCE_DIRS`" population from the shipped walkers. A literal list survives only
as an `arrayContaining` floor, alongside a non-empty anti-vacuity check.

**Why.** The block walked a literal three-element list under a comment saying
"the five files". Measured with the shipped walkers, the population is exactly
five — `next-env.d.ts`, `next.config.ts`, `playwright.config.ts`,
`scripts/capture_demo.ts`, `vitest.config.ts` — so the **count was right and the
list was short**. Two files in the population the comment describes were never
walked.

**The comment's own justification was backwards, and that is the lesson.** It
said the list "is asserted rather than counted so a file leaving the repo fails
loudly instead of shrinking a number". True for a file *leaving*. Exactly wrong
for one *entering*: a hand-transcribed list cannot notice a new member. A
justification that names one direction is silent about the other.

So both mechanisms are kept, because they protect opposite directions. The
derived set notices a file entering; the floor notices one leaving — the
property the old comment wanted, from a mechanism that actually provides it.

**Why #132 did not reach it.** #132 fixed `readRepoFiles`' *doc block*, which
said "five" and listed four *root-level* files. This is a different sentence, in
a different file, about a different population: "neither `test/` nor
`SOURCE_DIRS`" is the root-level files **plus** `scripts/`, which is why five is
right here and four was right there. Two adjacent claims with two different
correct counts is exactly when a transcription goes unnoticed.

**The counts are live and the list was a snapshot.** #132 measured 76 repo files
and 41 test files one day ago; this run measures 78 and 43, because #133 added
files. A population that moves between two sessions should never be transcribed.

**AC5, answered rather than left open.** `lib/sse-stream.ts:55`'s "Three of the
four copies used `startsWith(\"data: \")`" is *not* this shape — it is a
historical record of four implementations that were consolidated into one. There
is no live population for it to be wrong about. Don't re-open it.

**On falsification, honestly.** The floor cannot be turned red by any code-side
probe: it guards a change to the repository, not to this file. The one available
falsification is pasting the old three-element list back while keeping the floor
— that reddens it, measured. My first attempt at that probe deleted the floor
*along with* the derivation and came back green; that was an unfair probe, not a
result.

**Alternatives considered.**
- *Add the two missing files to the literal list.* Rejected: fixes today and
  leaves the mechanism that produced the gap.
- *Derive and drop the literal entirely.* Rejected: a derived set that shrinks
  to nothing passes silently.
- *Unify this with #132's partition test.* Rejected: they pin different
  populations, and four and five are both correct for theirs.
