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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROOT, sourceFiles, stripComments } from "./support/source-files";

/**
 * Every `app/api/**\/route.ts`, via the shared walk (#126).
 *
 * Was a private recursive `readdirSync` plus a `statSync` per entry, which put
 * this file on `EXEMPT_READDIR_FILES` in `strip-comments.test.ts` with the
 * reason "private but already recursive". That reason was true and nothing
 * enforced it: flatten the walk and the exemption's justification silently
 * becomes false. Using the shared walker removes the exemption instead of
 * trusting it. Verified to produce the identical five paths.
 */
function routeFiles(): string[] {
  return sourceFiles("app/api").filter((rel) => rel.endsWith("/route.ts"));
}

describe("API routes accept a plain Request", () => {
  const files = routeFiles();

  it("finds the route handlers to check", () => {
    // Anti-vacuous guard: if the glob ever stops matching, the scan below
    // passes trivially and the lock silently stops protecting anything.
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)("%s does not read req.nextUrl", (rel) => {
    const source = readFileSync(join(ROOT, rel), "utf8");
    // Strip comments first — the routes *document* why they avoid `nextUrl`,
    // and that prose must not trip the scan it is explaining.
    //
    // Via the shared `stripComments`, not an inlined copy (#126). The copy here
    // was byte-identical to the `LENIENT` spelling `strip-comments.test.ts`
    // keeps as the rejected comparison, under a comment saying "nothing should
    // be able to reach for the lenient one again" — and it stripped whole-line
    // comments only. So a route documenting its avoidance of `nextUrl` at the
    // END of the line it is about left that prose in `code`, and this negative
    // scan rejected a correct route. Measured (#126): two such shapes fail
    // under the lenient rule and pass under the shared one, with both agreeing
    // on a route that really does read `req.nextUrl`.
    const code = stripComments(source);
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

describe("structural: this file's scan goes through the shared stripper", () => {
  it("calls stripComments and declares no stripper of its own", () => {
    // The positive half of the rule-literal lock in `strip-comments.test.ts`.
    // That one says this file must not WRITE the rule; this says it must USE it.
    // A negative lock alone is satisfied by a file that stops stripping
    // altogether, which would make the `nextUrl` scan read prose as code -- the
    // same false failure, by deletion instead of by duplication (#126).
    const self = readFileSync(join(ROOT, "test/api-routes-accept-plain-request.test.ts"), "utf8");
    const code = self
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).toMatch(/\bstripComments\(source\)/);
    expect(code).toMatch(/from "\.\/support\/source-files"/);
  });
});

/**
 * The false FAILURE the shared stripper closes (#126).
 *
 * The scan above is negative — "no route mentions `.nextUrl`" — and the routes
 * deliberately *document* why they avoid it. The inlined copy this file used to
 * carry stripped whole-line comments only, so a route whose note sat at the END
 * of the line it described left that prose in `code` and the lock rejected a
 * correct route. Measured on `62b6a52`, two shapes failed under the lenient rule
 * and passed under the shared one, with both agreeing on a route that really does
 * read `req.nextUrl`.
 *
 * These rows run the rule over fixture sources rather than over the repo, because
 * the point is the shapes the repo does not happen to contain today. A lock whose
 * only evidence is "the current files pass" cannot tell a correct rule from a
 * lucky one.
 */
describe("the nextUrl scan reads code, not the prose explaining it", () => {
  const SCAN = /\.nextUrl\b/;
  const scan = (src: string): boolean => SCAN.test(stripComments(src));

  // Exported for the LENIENT comparison in strip-comments.test.ts.
  const CORRECT = [
    [
      "whole-line note (the shape every route uses today)",
      'export async function GET(req: Request) {\n' +
        '  // never req.nextUrl: undefined on a plain Request\n' +
        '  const u = new URL(req.url);\n}\n',
    ],
    [
      "trailing note on the line it describes",
      'export async function GET(req: Request) {\n' +
        '  const u = new URL(req.url); // not req.nextUrl — undefined on a plain Request\n}\n',
    ],
    [
      "trailing note after an import",
      'import { x } from "y"; // req.nextUrl is a NextRequest extension\n' +
        'export async function GET(req: Request) { return new Response(); }\n',
    ],
    [
      "note inside a JSDoc block",
      '/** Reads the param via `new URL`, never `req.nextUrl`. */\n' +
        'export async function GET(req: Request) { return new Response(); }\n',
    ],
  ] as const;

  it.each(CORRECT)("passes a correct route: %s", (_label, src) => {
    expect(scan(src), "the scan rejected a route that does not use req.nextUrl").toBe(false);
  });

  it("still fails a route that really does read req.nextUrl", () => {
    // Anti-vacuous: without this the rows above are satisfied by a scan that
    // never matches anything.
    expect(scan('export async function GET(req) {\n  const u = req.nextUrl;\n}\n')).toBe(true);
  });

  // The "which rows does the lenient spelling reject" comparison lives in
  // `test/strip-comments.test.ts`, beside the `LENIENT` fixture that is the only
  // sanctioned place to write that spelling down. Writing it here would have been
  // a SEVENTH copy of the rule -- and the new rule-literal lock caught exactly
  // that when this arm was first drafted here, which is the neatest argument for
  // having keyed that lock on the rule rather than on the function name (#126).
});
