/**
 * `POST /api/optimistic` answers a non-object JSON body with its 400 (#140).
 *
 * `null` is valid JSON, so it passed the `req.json()` try/catch and then
 * `body.id` threw `TypeError: Cannot read properties of null` -- a 500, where
 * the route documents `400 { ok: false, reason: "bad request: ..." }`. Every
 * other non-object reached the `id` check only because `"x".id` is undefined.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST } from "../app/api/optimistic/route";
import { sourceFiles, stripComments } from "./support/source-files";

const ROOT = resolve(__dirname, "..");

function rawRequest(body: string): NextRequest {
  // A plain Request is what the route reads (`.json()` only); see
  // api-routes-accept-plain-request.test.ts.
  return new Request("http://localhost/api/optimistic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }) as unknown as NextRequest;
}

describe("POST /api/optimistic — body shape", () => {
  it.each(["null", '"x"', "42", "true", "[]", '[{"id":"a","click_count":1}]'])(
    "refuses %s as not a JSON object",
    async (raw) => {
      const res = await POST(rawRequest(raw));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        reason: "bad request: body must be a JSON object",
      });
    },
  );

  it("still names the missing field for an object without one", async () => {
    const res = await POST(rawRequest("{}"));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("bad request: `id` must be a non-empty string");
  });

  it("still accepts a well-formed object", async () => {
    const res = await POST(rawRequest('{"id":"a","click_count":1}'));
    expect(res.status).toBe(200);
  });
});

describe("every API route that parses a JSON body guards its shape", () => {
  const jsonRoutes = sourceFiles("app/api")
    .filter((p) => p.endsWith("route.ts"))
    .filter((p) => /\breq(?:uest)?\.json\(\)/.test(stripComments(readFileSync(resolve(ROOT, p), "utf8"))));

  it("finds the routes (non-zero control)", () => {
    expect(jsonRoutes.length).toBeGreaterThanOrEqual(1);
  });

  it.each(jsonRoutes)("%s refuses null and non-objects before reading a field", (p) => {
    const src = stripComments(readFileSync(resolve(ROOT, p), "utf8"));
    expect(src).toMatch(/=== null \|\| typeof \w+ !== "object" \|\| Array\.isArray\(\w+\)/);
  });
});
