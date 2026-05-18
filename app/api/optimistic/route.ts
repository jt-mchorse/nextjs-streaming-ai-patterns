import { NextRequest } from "next/server";

import { decide, type Decision } from "@/lib/optimistic-decision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RequestBody {
  id?: unknown;
  click_count?: unknown;
}

/**
 * POST /api/optimistic
 *
 * Body: `{ id: string, click_count: number }` — the item the user
 * clicked "improve" on, plus how many times they've clicked it.
 *
 * Returns the deterministic `decide()` Decision as JSON:
 *
 *   200  { ok: true,  improved_name: string }     — commit the optimistic update
 *   200  { ok: false, reason: string }            — roll back with the reason
 *   400  { ok: false, reason: "bad request: ..." }
 *
 * The 50/50 split is purposely *deterministic* per (id, click_count) so
 * tests can exercise both branches by construction (D-010, mirroring
 * D-003 / D-008's "deterministic demo, real source visible" posture).
 *
 * The first click on each id always succeeds — a casual visitor sees
 * the happy path first, then a rollback animation on click 2 if they
 * try again.
 */
export async function POST(req: NextRequest): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonResponse(
      400,
      { ok: false, reason: "bad request: body was not valid JSON" },
    );
  }

  if (typeof body.id !== "string" || body.id.length === 0) {
    return jsonResponse(
      400,
      { ok: false, reason: "bad request: `id` must be a non-empty string" },
    );
  }
  if (
    typeof body.click_count !== "number" ||
    !Number.isInteger(body.click_count) ||
    body.click_count < 1
  ) {
    return jsonResponse(400, {
      ok: false,
      reason: "bad request: `click_count` must be a positive integer",
    });
  }

  const decision = decide({ id: body.id, click_count: body.click_count });
  return jsonResponse(200, decision);
}

function jsonResponse(status: number, body: Decision): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
