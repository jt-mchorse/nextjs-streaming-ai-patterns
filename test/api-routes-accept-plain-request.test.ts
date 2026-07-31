/**
 * Lock: every `app/api/**\/route.ts` handler works with a plain `Request` (#91).
 *
 * `error-recovery` has read its query param through `new URL(req.url)` since
 * #58, with a comment explaining that `req.nextUrl` is a `NextRequest`
 * extension and is `undefined` on a plain `Request`. `stream-text` kept
 * `req.nextUrl` and therefore threw an opaque
 * `TypeError: Cannot read properties of undefined (reading 'searchParams')`
 * before the handler did anything — visible in the test suite as an asymmetry,
 * where `error-recovery-route.test.ts` constructs a plain `new Request(...)`
 * while `stream-text-route.test.ts` was forced to construct a `NextRequest`.
 *
 * Having now applied the same one-line fix twice, lock the contract instead of
 * waiting for a sixth route to reintroduce it. The source scan is the durable
 * half: a new route that reaches for `req.nextUrl` fails here immediately,
 * without anyone having to remember to add a plain-`Request` test for it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(__dirname, "..");
const API_DIR = join(ROOT, "app", "api");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("API routes accept a plain Request", () => {
  const files = routeFiles(API_DIR);

  it("finds the route handlers to check", () => {
    // Anti-vacuous guard: if the glob ever stops matching, the scan below
    // passes trivially and the lock silently stops protecting anything.
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files.map((f) => relative(ROOT, f)))("%s does not read req.nextUrl", (rel) => {
    const source = readFileSync(join(ROOT, rel), "utf8");
    // Strip comments first — the routes *document* why they avoid `nextUrl`,
    // and that prose must not trip the scan it is explaining.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.nextUrl\b/);
  });
});

// The mock streamer emits a fixed fixture and ignores the prompt (deliberately
// — it is deterministic by design), so the prompt is not observable in the
// response body. Spy on `streamText` instead, which asserts the stronger thing:
// the query param was not merely read without throwing, it reached the streamer.
vi.mock("@/lib/anthropic-stream", () => ({
  async *streamText(prompt: string) {
    seenPrompts.push(prompt);
    yield { text: "ok" };
  },
}));

const seenPrompts: string[] = [];

describe("stream-text honors the prompt from a plain Request", () => {
  beforeEach(() => {
    seenPrompts.length = 0;
  });

  it("reads the prompt off a plain Request and passes it to streamText", async () => {
    const { GET } = await import("../app/api/stream-text/route");
    // A plain `Request`, not a `NextRequest` — the shape that used to throw
    // `TypeError: Cannot read properties of undefined (reading 'searchParams')`.
    const res = await GET(
      new Request("http://localhost/api/stream-text?prompt=hello+there") as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.text();

    expect(seenPrompts).toEqual(["hello there"]);
  });

  it("falls back to the default prompt when the param is absent", async () => {
    const { GET } = await import("../app/api/stream-text/route");
    const res = await GET(new Request("http://localhost/api/stream-text") as never);
    expect(res.status).toBe(200);
    await res.text();

    expect(seenPrompts).toHaveLength(1);
    expect(seenPrompts[0]).toContain("streaming output beats waiting");
  });
});
