/**
 * `streamCheckpoints` paces its text events (#230).
 *
 * It had no per-token delay, ever. So `/api/error-recovery` emitted its whole
 * pre-drop burst, and then its whole resumed answer, within about a
 * millisecond. Measured on 2da5ddd, timing `reader.read()` on the route body:
 *
 *   error-recovery ?checkpoint=0   reads 15,  bytes 769,  span 0 ms
 *   error-recovery ?checkpoint=12  reads 151, bytes 7435, span 0 ms
 *   tool-use (control)             reads 45,  bytes 2109, span 2040 ms
 *
 * The page never showed a token arriving, while the route's own #74 comment
 * calls "the incremental checkpoint/drop/resume sequence" the entire point. It
 * now takes the sibling streamers' `baseDelayMs` / `jitterMs` / `seed` (default
 * 30 / 30) and sleeps before each text event.
 *
 * The option validation is covered by the shared tables
 * (`stream-delay-defaults`, `mock-stream-timeout-clamp`,
 * `mock-stream-seed-validation`, `stream-delay-abort-listeners`), which now
 * have a `streamCheckpoints` row. This file covers the schedule itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/error-recovery/route";
import { TOTAL_TOKENS, streamCheckpoints, type StreamEvent, type StreamOptions } from "@/lib/checkpoint-stream";

import { ROOT } from "./support/source-files";

/**
 * Run the generator with `setTimeout` spied: each delay is recorded and its
 * timer fired on the next tick, so no test waits out real jitter. A zero delay
 * never reaches `setTimeout` (`abortableSleep` returns early).
 */
async function schedule(options: StreamOptions): Promise<{ delays: number[]; events: StreamEvent[] }> {
  const realSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(Number(ms));
    return realSetTimeout(fn, 0);
  }) as unknown as typeof setTimeout);
  const events: StreamEvent[] = [];
  try {
    for await (const e of streamCheckpoints(options)) events.push(e);
  } catch {
    // A simulated drop ends the run; the schedule up to it is what is checked.
  } finally {
    vi.restoreAllMocks();
  }
  return { delays, events };
}

const texts = (events: StreamEvent[]) => events.filter((e) => e.kind === "text");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("streamCheckpoints paces each text event (#230)", () => {
  it("with the defaults, every text event waits 30 ms plus up to 30 ms of jitter", async () => {
    const { delays, events } = await schedule({ dropAfter: 12 });
    expect(texts(events)).toHaveLength(12);
    // One sleep per text event. Checkpoints ride on the event they follow.
    expect(delays).toHaveLength(12);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(30);
      expect(d).toBeLessThan(60);
    }
  });

  it("a full run sleeps once per text event, and never for a checkpoint", async () => {
    const { delays, events } = await schedule({ seed: 7 });
    expect(texts(events)).toHaveLength(TOTAL_TOKENS);
    expect(events.length).toBeGreaterThan(TOTAL_TOKENS); // checkpoints were emitted
    expect(delays).toHaveLength(TOTAL_TOKENS);
  });

  it("the tokens a resume skips are not paced", async () => {
    // A resume should not wait out the tokens it is not sending.
    const { delays, events } = await schedule({ startAfter: TOTAL_TOKENS - 2 });
    expect(texts(events)).toHaveLength(2);
    expect(delays).toHaveLength(2);
  });

  it("baseDelayMs and jitterMs are the ones honoured", async () => {
    const { delays } = await schedule({ baseDelayMs: 5, jitterMs: 0, dropAfter: 4 });
    expect(delays).toEqual([5, 5, 5, 5]);
  });

  it("a seed fixes the schedule, and a different seed changes it", async () => {
    const opts = { baseDelayMs: 0, jitterMs: 1000, dropAfter: 12 } as const;
    const a = await schedule({ ...opts, seed: 1 });
    const b = await schedule({ ...opts, seed: 1 });
    const c = await schedule({ ...opts, seed: 2 });
    expect(a.delays.length).toBeGreaterThan(0);
    expect(a.delays).toEqual(b.delays);
    expect(a.delays).not.toEqual(c.delays);
  });

  it("control: zero delay stays instant, the shape the other tests use", async () => {
    const { delays, events } = await schedule({ baseDelayMs: 0, jitterMs: 0 });
    expect(texts(events)).toHaveLength(TOTAL_TOKENS);
    expect(delays).toEqual([]);
  });

  it("an abort during the sleep ends the stream without emitting the token (D-007)", async () => {
    const ac = new AbortController();
    const gen = streamCheckpoints({ baseDelayMs: 10_000, jitterMs: 0, signal: ac.signal });
    const t0 = Date.now();
    const step = gen.next();
    setTimeout(() => ac.abort(), 20);
    const r = await step;
    expect(r.done).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("GET /api/error-recovery spreads the drop burst over time (#230)", () => {
  it("the 12 pre-drop text frames arrive over at least 11 default delays, not in one burst", async () => {
    const res = await GET(new NextRequest("http://localhost/api/error-recovery?checkpoint=0"));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const arrivals: number[] = [];
    let body = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      body += chunk;
      // One arrival per text frame, so two frames in one read share a time.
      const now = performance.now();
      const frames = chunk.match(/"kind":"text"/g)?.length ?? 0;
      for (let i = 0; i < frames; i++) arrivals.push(now);
    }
    expect(body).toContain("event: error");
    expect(arrivals).toHaveLength(12);
    // Before #230 this span was 0-1 ms. With the 30 ms base delay the eleven
    // gaps between the twelve text frames are each at least 30 ms (a little
    // slack for timer granularity).
    expect(arrivals[arrivals.length - 1] - arrivals[0]).toBeGreaterThanOrEqual(11 * 30 - 15);
  }, 10_000);
});

describe("one PRNG (#230)", () => {
  it("no paced streamer keeps a private makePrng", () => {
    for (const file of [
      "lib/mock-stream.ts",
      "lib/mock-json-stream.ts",
      "lib/mock-tool-stream.ts",
      "lib/checkpoint-stream.ts",
    ]) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src, file).not.toMatch(/function\s+makePrng\s*\(/);
      expect(src, file).toMatch(/import \{[^}]*\bmakePrng\b[^}]*\} from "@\/lib\/stream-delay"/);
    }
  });
});
