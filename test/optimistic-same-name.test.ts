/**
 * A successful "improve" never commits the name already showing (#154).
 *
 * `decide` drew a success's name from all three of the id's options with no
 * view of the current name, so a success could "improve" a file to the name it
 * already had: no change, no rollback, no reason. Measured on `main` by chaining
 * each success into the next click over the five demo ids, clicks 1..10:
 * 5 of 27 successes returned the current name (e.g. untitled-3.txt click 2,
 * onboarding-guide.md -> onboarding-guide.md).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { POST } from "../app/api/optimistic/route";
import { DEMO_NAMES, decide } from "../lib/optimistic-decision";

function chain(id: string, clicks: number, withCurrent: boolean) {
  let current = id;
  const out: { ok: boolean; name?: string; current: string }[] = [];
  for (let k = 1; k <= clicks; k++) {
    const d = decide({ id, click_count: k, ...(withCurrent ? { current_name: current } : {}) });
    out.push({ ok: d.ok, name: d.ok ? d.improved_name : undefined, current });
    if (d.ok) current = d.improved_name;
  }
  return out;
}

describe("decide with current_name (#154)", () => {
  it("no success over 200 chained clicks per demo id returns the name already showing", () => {
    for (const id of DEMO_NAMES) {
      for (const step of chain(id, 200, true)) {
        if (step.ok) expect(step.name).not.toBe(step.current);
      }
    }
  });

  it("whether a click succeeds is unchanged: D-010's split is not touched", () => {
    for (const id of DEMO_NAMES) {
      expect(chain(id, 200, true).map((s) => s.ok)).toEqual(chain(id, 200, false).map((s) => s.ok));
    }
  });

  it("without current_name the names are what they always were (back-compat)", () => {
    expect(decide({ id: "untitled-3.txt", click_count: 1 })).toEqual({
      ok: true,
      improved_name: "onboarding-guide.md",
    });
  });

  it("a custom id's fallback name also avoids the current one", () => {
    const first = decide({ id: "report.txt", click_count: 1 });
    expect(first).toEqual({ ok: true, improved_name: "report-improved.md" });
    const again = decide({ id: "report.txt", click_count: 1, current_name: "report-improved.md" });
    expect(again.ok && again.improved_name).not.toBe("report-improved.md");
  });

  it("a non-string current_name is refused", () => {
    expect(() => decide({ id: "untitled-1.txt", click_count: 1, current_name: 5 as never })).toThrow(/current_name/);
  });
});

describe("the route and the client carry current_name (#154)", () => {
  const req = (body: unknown) =>
    new Request("http://localhost/api/optimistic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("the route passes current_name to decide", async () => {
    const res = await POST(req({ id: "untitled-3.txt", click_count: 1, current_name: "onboarding-guide.md" }) as never);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.improved_name).not.toBe("onboarding-guide.md");
  });

  it("the route answers a non-string current_name with 400", async () => {
    const res = await POST(req({ id: "untitled-3.txt", click_count: 1, current_name: 7 }) as never);
    expect(res.status).toBe(400);
  });

  it("the client sends the committed name", () => {
    const src = readFileSync(resolve(__dirname, "..", "components", "optimistic-rollback-client.tsx"), "utf8");
    expect(src).toMatch(/JSON\.stringify\(\{ id, click_count, current_name \}\)/);
    expect(src).toMatch(/callApi\(id, nextClicks, item\?\.name \?\? id\)/);
  });
});
