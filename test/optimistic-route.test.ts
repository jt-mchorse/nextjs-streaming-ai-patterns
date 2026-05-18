import { describe, expect, it } from "vitest";

import { POST } from "../app/api/optimistic/route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/optimistic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/optimistic — happy path", () => {
  it("returns a success decision on first click of a demo id", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest({ id: "untitled-1.txt", click_count: 1 }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.improved_name).toBe("string");
    expect(body.improved_name.length).toBeGreaterThan(0);
  });
});

describe("POST /api/optimistic — rollback path", () => {
  it("returns a rollback decision on a later click that maps to ok=false", async () => {
    // The split tests in optimistic-decision.test.ts pin that failures
    // exist in 2..200. Probe deterministically.
    let foundFailure = false;
    for (let c = 2; c < 50 && !foundFailure; c++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await POST(makeRequest({ id: "untitled-4.txt", click_count: c }) as any);
      const body = await res.json();
      if (!body.ok) {
        foundFailure = true;
        expect(res.status).toBe(200);
        expect(typeof body.reason).toBe("string");
        expect(body.reason.length).toBeGreaterThan(0);
      }
    }
    expect(foundFailure).toBe(true);
  });
});

describe("POST /api/optimistic — bad request", () => {
  it("rejects a missing id", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest({ click_count: 1 }) as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("id");
  });

  it("rejects a non-integer click_count", async () => {
    const res = await POST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest({ id: "untitled-1.txt", click_count: 1.5 }) as any,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("click_count");
  });

  it("rejects a click_count of 0", async () => {
    const res = await POST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest({ id: "untitled-1.txt", click_count: 0 }) as any,
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const req = new Request("http://localhost/api/optimistic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

describe("POST /api/optimistic — determinism over the wire", () => {
  it("returns byte-identical responses for the same inputs", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r1 = await POST(makeRequest({ id: "untitled-2.txt", click_count: 7 }) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r2 = await POST(makeRequest({ id: "untitled-2.txt", click_count: 7 }) as any);
    expect(await r1.json()).toEqual(await r2.json());
  });
});
