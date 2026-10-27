/**
 * `seed` used to be the one numeric option of the mock streamers that nothing
 * validated (#221). Each PRNG starts from `seed >>> 0`, which coerces instead
 * of refusing, so distinct seeds silently shared a schedule: `NaN`, `Infinity`
 * and `2**32` all became `0`, `1.9` became `1`, and `-1` became `4294967295`.
 * `baseDelayMs`/`jitterMs` throw a named `RangeError` on bad values (#26,
 * #102); `seed` now does the same, via the shared `validateSeed`.
 *
 * Table-driven over every paced streamer, like `mock-stream-timeout-clamp`.
 * `streamCheckpoints` joined the table when it gained a seed (#230).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { streamCheckpoints } from "@/lib/checkpoint-stream";
import { mockJsonStream } from "@/lib/mock-json-stream";
import { mockTextStream } from "@/lib/mock-stream";
import { mockToolStream } from "@/lib/mock-tool-stream";

const STREAMS = [
  ["mockTextStream", "MockStreamOptions", (o: object) => mockTextStream(o)],
  ["mockJsonStream", "MockJsonStreamOptions", (o: object) => mockJsonStream(o)],
  ["mockToolStream", "MockToolStreamOptions", (o: object) => mockToolStream(o)],
  ["streamCheckpoints", "StreamOptions", (o: object) => streamCheckpoints(o)],
] as const;

// Every value here was accepted before #221 and aliased another seed.
const BAD_SEEDS: ReadonlyArray<readonly [string, number]> = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["1.9", 1.9],
  ["-1", -1],
  ["2**32", 2 ** 32],
];

// The schedule needs a non-zero jitter to depend on the seed at all.
const JITTER = { baseDelayMs: 0, jitterMs: 1000 } as const;

async function rejectionOf(gen: AsyncGenerator<unknown>): Promise<unknown> {
  // Async generators validate on the first `next()`, not on construction.
  try {
    await gen.next();
  } catch (e) {
    return e;
  } finally {
    await gen.return(undefined).catch(() => {});
  }
  return undefined;
}

/**
 * The delays a stream hands to `setTimeout` over its first `n` steps. The spy
 * fires each timer on the next tick so no test waits out real jitter. A zero
 * delay never reaches `setTimeout` (`abortableSleep` returns early), so the
 * recorded list can be shorter than `n`; it is still a function of the seed.
 */
async function delaySchedule(make: (o: object) => AsyncGenerator<unknown>, seed: number, n = 12) {
  const realSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(Number(ms));
    return realSetTimeout(fn, 0);
  }) as unknown as typeof setTimeout);
  const gen = make({ ...JITTER, seed });
  try {
    for (let i = 0; i < n; i++) await gen.next();
  } finally {
    await gen.return(undefined);
    vi.restoreAllMocks();
  }
  return delays;
}

describe.each(STREAMS)("%s — seed is validated (#221)", (_name, label, make) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(BAD_SEEDS)("seed %s is rejected with a RangeError naming the option", async (_l, seed) => {
    const err = await rejectionOf(make({ ...JITTER, seed }));
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toContain(`${label}.seed`);
  });

  it("control: an omitted seed is accepted", async () => {
    const err = await rejectionOf(make({ baseDelayMs: 0, jitterMs: 0 }));
    expect(err).toBeUndefined();
  });

  it.each([0, 1, 2 ** 32 - 1])("control: seed %d is accepted", async (seed) => {
    const err = await rejectionOf(make({ baseDelayMs: 0, jitterMs: 0, seed }));
    expect(err).toBeUndefined();
  });

  it("control: the boundary seeds 0, 1 and 2**32 - 1 give distinct schedules", async () => {
    const a = await delaySchedule(make, 0);
    const b = await delaySchedule(make, 1);
    const c = await delaySchedule(make, 2 ** 32 - 1);
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
    expect(b).not.toEqual(c);
  });
});
