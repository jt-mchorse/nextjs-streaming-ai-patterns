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
