/**
 * The mock streamers' sleep left one `abort` listener per token on the route's
 * signal (#179).
 *
 * Each streamer had a private `sleep(ms, signal)` that added
 * `addEventListener("abort", onAbort, { once: true })` and removed it only when
 * the abort fired. `{ once: true }` removes a listener after it runs; on a
 * stream nobody aborts it never runs. Measured on full un-aborted runs: 115
 * listeners left by `mockTextStream`, 65 by `mockJsonStream`, 45 by
 * `mockToolStream`, and on Node 20 one mock-mode `GET /api/stream-text` printed
 * `MaxListenersExceededWarning: Possible EventTarget memory leak detected`.
 *
 * Counted with `getEventListeners`, not by waiting for the warning: Node 22+
 * stopped printing it, and the listeners are there either way.
 */
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mockJsonStream } from "@/lib/mock-json-stream";
import { mockTextStream } from "@/lib/mock-stream";
import { mockToolStream } from "@/lib/mock-tool-stream";
import { abortableSleep } from "@/lib/stream-delay";

import { ROOT } from "./support/source-files";

const abortListeners = (signal: AbortSignal): number => getEventListeners(signal, "abort").length;

// `seed` is omitted on purpose: `mockTextStream` skips its sleeps when a seed is
// set, and the sleeps are what this is about. 1 ms keeps the real waits short.
const STREAMERS = [
  ["mockTextStream", (signal: AbortSignal) => mockTextStream({ signal, baseDelayMs: 1, jitterMs: 0 })],
  ["mockJsonStream", (signal: AbortSignal) => mockJsonStream({ signal, baseDelayMs: 1, jitterMs: 0 })],
  ["mockToolStream", (signal: AbortSignal) => mockToolStream({ signal, baseDelayMs: 1, jitterMs: 0 })],
] as const;

describe("mock streamers leave no abort listener behind (#179)", () => {
  for (const [name, start] of STREAMERS) {
    it(`${name}: a full un-aborted run leaves 0 abort listeners on the signal`, async () => {
      const ac = new AbortController();
      let events = 0;
      let mostSeenAtAYield = 0;
      for await (const _event of start(ac.signal)) {
        events += 1;
        mostSeenAtAYield = Math.max(mostSeenAtAYield, abortListeners(ac.signal));
      }
      // Control: the run did sleep between many events, so a leak had room to show.
      expect(events).toBeGreaterThan(10);
      expect(mostSeenAtAYield).toBe(0);
      expect(abortListeners(ac.signal)).toBe(0);
    });
  }
});

describe("abortableSleep (#179)", () => {
  it("holds exactly one listener while pending and none once the timer fires", async () => {
    const ac = new AbortController();
    const pending = abortableSleep(5, ac.signal);
    expect(abortListeners(ac.signal)).toBe(1);
    await pending;
    expect(abortListeners(ac.signal)).toBe(0);
  });

  it("still resolves immediately when the signal aborts mid-sleep (D-007)", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const pending = abortableSleep(10_000, ac.signal);
    ac.abort();
    await pending;
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(abortListeners(ac.signal)).toBe(0);
  });

  it("adds no listener for an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    await abortableSleep(10_000, ac.signal);
    expect(abortListeners(ac.signal)).toBe(0);
  });

  it("is the only sleep: no mock streamer keeps a private copy", () => {
    for (const file of ["lib/mock-stream.ts", "lib/mock-json-stream.ts", "lib/mock-tool-stream.ts"]) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src, file).not.toMatch(/function\s+sleep\s*\(/);
      expect(src, file).toMatch(/import \{[^}]*\babortableSleep\b[^}]*\} from "@\/lib\/stream-delay"/);
    }
  });
});
