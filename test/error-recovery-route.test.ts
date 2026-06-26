import { describe, expect, it } from "vitest";

import { GET } from "../app/api/error-recovery/route";
import { resumeTokenPosition, streamCheckpoints } from "../lib/checkpoint-stream";

/** The canonical clean stream text — all tokens, no drop. */
async function cleanStreamText(): Promise<string> {
  let text = "";
  for await (const ev of streamCheckpoints({})) {
    if (ev.kind === "text") text += ev.text;
  }
  return text;
}

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

// Issue #58: the drop→resume round trip must not duplicate the tokens between
// the last checkpoint and the drop. This simulates the client accumulation
// exactly: collect text + record the last checkpoint on run 1 (which drops),
// then resume and keep appending. The resume position is the only difference.
describe("GET /api/error-recovery — drop→resume round trip (issue #58)", () => {
  async function runClient(
    resumeFrom: (lastCheckpoint: number, droppedAt?: number) => number,
  ): Promise<string> {
    let text = "";
    let lastCheckpoint = 0;
    let droppedAt: number | undefined;
    // Run 1: first request drops mid-stream.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const f of parseSSE(await readAllText(await GET(makeReq("?checkpoint=0") as any)))) {
      if (f.event === "error") {
        droppedAt = (f.data as { last_token?: number }).last_token;
        break;
      }
      const ev = f.data as
        | { kind: "text"; text: string }
        | { kind: "checkpoint"; last_token: number };
      if (ev.kind === "text") text += ev.text;
      else if (ev.kind === "checkpoint") lastCheckpoint = ev.last_token;
    }
    expect(droppedAt).toBeGreaterThan(lastCheckpoint); // the bug's precondition
    const resume = resumeFrom(lastCheckpoint, droppedAt);
    // Run 2: resume request streams cleanly to `done`.
    for (const f of parseSSE(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await readAllText(await GET(makeReq(`?checkpoint=${resume}`) as any)),
    )) {
      if (f.event === "done" || f.event === "error") break;
      const ev = f.data as { kind: string; text?: string };
      if (ev.kind === "text") text += ev.text;
    }
    return text;
  }

  it("resuming from the drop position (last_token) reconstructs the clean stream exactly", async () => {
    const fromDrop = await runClient((cp, dropped) => resumeTokenPosition(cp, dropped));
    expect(fromDrop).toBe(await cleanStreamText());
  });

  it("resuming from the last checkpoint duplicates the in-between tokens (locks the bug)", async () => {
    const fromCheckpoint = await runClient((cp) => cp); // the old buggy behavior
    const clean = await cleanStreamText();
    // The buggy path re-renders the tokens between the checkpoint and the drop,
    // so it is strictly longer than the clean stream and contains a duplicated
    // word-pair at the seam.
    expect(fromCheckpoint.length).toBeGreaterThan(clean.length);
    expect(fromCheckpoint).toMatch(/\b(\w+ \w+) \1\b/);
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
