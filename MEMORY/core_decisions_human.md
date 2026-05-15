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
