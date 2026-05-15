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
