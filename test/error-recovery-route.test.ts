import { describe, expect, it } from "vitest";

import { GET } from "../app/api/error-recovery/route";

async function readAllText(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function parseSSE(blob: string): Array<{ event?: string; data: unknown }> {
  return blob
    .split("\n\n")
    .filter((s) => s.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      let event: string | undefined;
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        else if (line.startsWith("data: ")) data = line.slice("data: ".length);
      }
      return { event, data: JSON.parse(data) };
    });
}

function makeReq(qs: string): Request {
  return new Request(`http://localhost/api/error-recovery${qs}`);
}

describe("GET /api/error-recovery — first request", () => {
  it("emits text + checkpoint events and then drops with an `error` SSE event", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(makeReq("") as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const body = await readAllText(res);
    const frames = parseSSE(body);

    // Last frame is the simulated `error` — the server doesn't emit
    // `done` on a drop.
    const last = frames[frames.length - 1];
    expect(last.event).toBe("error");
    expect((last.data as { reason: string }).reason).toContain("dropped");

    // Text events appeared before the drop.
    const textCount = frames.filter(
      (f) => !f.event && (f.data as { kind: string }).kind === "text",
    ).length;
    expect(textCount).toBeGreaterThan(0);

    // At least one checkpoint appeared before the drop (since DROP_AFTER >
    // CHECKPOINT_EVERY).
    const cpCount = frames.filter(
      (f) => !f.event && (f.data as { kind: string }).kind === "checkpoint",
    ).length;
    expect(cpCount).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/error-recovery — resume request", () => {
  it("streams cleanly to `done` when checkpoint > 0", async () => {
    // First request lets us discover where it dropped — but for the
    // resume test we just pick a sane checkpoint > 0 and assert the
    // resume path runs to completion.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(makeReq("?checkpoint=10") as any);
    expect(res.status).toBe(200);

    const body = await readAllText(res);
    const frames = parseSSE(body);

    // Last frame is `done`.
    const last = frames[frames.length - 1];
    expect(last.event).toBe("done");

    // No `error` event in the resume stream.
    const errors = frames.filter((f) => f.event === "error");
    expect(errors.length).toBe(0);

    // Every text event's index is > 10 (the resume point).
    const textIndices = frames
      .filter((f) => !f.event && (f.data as { kind: string }).kind === "text")
      .map((f) => (f.data as { index: number }).index);
    expect(textIndices.length).toBeGreaterThan(0);
    for (const idx of textIndices) {
      expect(idx).toBeGreaterThan(10);
    }
  });
});

describe("GET /api/error-recovery — input validation", () => {
  it("treats a non-integer checkpoint as 0 (first request, will drop)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(makeReq("?checkpoint=abc") as any);
    const body = await readAllText(res);
    const frames = parseSSE(body);
    const last = frames[frames.length - 1];
    // Falls back to checkpoint=0 → drop branch fires.
    expect(last.event).toBe("error");
  });

  it("treats a negative checkpoint as 0", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(makeReq("?checkpoint=-5") as any);
    const body = await readAllText(res);
    const frames = parseSSE(body);
    const last = frames[frames.length - 1];
    expect(last.event).toBe("error");
  });
});
