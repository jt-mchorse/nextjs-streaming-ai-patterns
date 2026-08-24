/**
 * A finite delay can be too large for `setTimeout`, and the failure is silent
 * and inverted: ask for a very slow stream, get an instantaneous one.
 *
 * The three mock streamers share one `validateOptions` shape, and its comment
 * has always named the 32-bit `setTimeout` clamp as the hazard. It closed only
 * the non-finite half. A finite `2**31` hits the same clamp and reproduces the
 * `NaN` outcome exactly — every token dumped at once (#102).
 *
 * The comment also mis-stated what `Infinity` does ("hung forever ... ~24-50
 * day clamp"). It doesn't: Node clamps it to 1 ms like `NaN`. That mistake is
 * plausibly why nothing bounded delays from above — if you believe large values
 * are slow, you don't think to cap them.
 *
 * `checkpoint-stream.ts` is deliberately not covered here. Its `validateOptions`
 * guards `startAfter` / `dropAfter`, which are integer indices into an event
 * sequence, not delays, so they never reach `setTimeout`.
 */
import { describe, expect, it } from "vitest";

import { mockJsonStream } from "@/lib/mock-json-stream";
import { mockTextStream } from "@/lib/mock-stream";
import { mockToolStream } from "@/lib/mock-tool-stream";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const STREAMS = [
  ["mockTextStream", "MockStreamOptions", (o: object) => mockTextStream(o)],
  ["mockJsonStream", "MockJsonStreamOptions", (o: object) => mockJsonStream(o)],
  ["mockToolStream", "MockToolStreamOptions", (o: object) => mockToolStream(o)],
] as const;

/**
 * These are async *generators*: calling them only constructs the generator, so
 * `validateOptions` does not run until the first `next()`. Every rejection
 * assertion therefore drives one step, matching the existing idiom in
 * `test/mock-stream.test.ts`.
 */
async function expectRejects(make: () => AsyncGenerator<unknown>) {
  await expect(make().next()).rejects.toBeInstanceOf(RangeError);
}

async function rejectionMessage(make: () => AsyncGenerator<unknown>): Promise<string> {
  try {
    await make().next();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection, got none");
}

async function expectAccepts(make: () => AsyncGenerator<unknown>) {
  // Construct and take one step under a short race: acceptance means we get
  // either an event or a still-pending sleep, never a RangeError.
  const gen = make();
  const outcome = await Promise.race([
    gen.next().then(() => "stepped" as const, (e: unknown) => e as Error),
    new Promise<"PENDING">((r) => setTimeout(() => r("PENDING"), 60)),
  ]);
  expect(outcome).not.toBeInstanceOf(RangeError);
}

/** Drive the generator far enough to reach its first `sleep`. */
async function firstEvent(make: () => AsyncGenerator<unknown>, budgetMs: number) {
  const gen = make();
  return Promise.race([
    (async () => {
      for await (const _ of gen) return "yielded" as const;
      return "empty" as const;
    })(),
    new Promise<"PENDING">((r) => setTimeout(() => r("PENDING"), budgetMs)),
  ]);
}

describe.each(STREAMS)("%s: setTimeout clamp", (_name, iface, make) => {
  it("rejects a baseDelayMs at the clamp boundary", async () => {
    await expectRejects(() => make({ baseDelayMs: 2 ** 31 }));
    expect(await rejectionMessage(() => make({ baseDelayMs: 2 ** 31 }))).toMatch(/2\*\*31 - 1/);
  });

  it.each([2 ** 31, 2 ** 32, 5e9, Number.MAX_SAFE_INTEGER])(
    "rejects baseDelayMs=%d",
    async (v) => {
      await expectRejects(() => make({ baseDelayMs: v }));
    },
  );

  it.each([2 ** 31, 2 ** 32, 5e9, Number.MAX_SAFE_INTEGER])(
    "rejects jitterMs=%d",
    async (v) => {
      await expectRejects(() => make({ jitterMs: v }));
    },
  );

  it("still accepts exactly 2**31 - 1 — the bound is the clamp, not a round number", async () => {
    await expectAccepts(() => make({ baseDelayMs: MAX_TIMEOUT_MS, jitterMs: 0 }));
    await expectAccepts(() => make({ baseDelayMs: 0, jitterMs: MAX_TIMEOUT_MS }));
  }, 10000);

  it("still accepts ordinary delays", async () => {
    await expectAccepts(() => make({ baseDelayMs: 30, jitterMs: 30 }));
    await expectAccepts(() => make({}));
  }, 10000);

  it("still rejects the non-finite and negative cases it always did", async () => {
    await expectRejects(() => make({ baseDelayMs: NaN }));
    await expectRejects(() => make({ baseDelayMs: Infinity }));
    await expectRejects(() => make({ baseDelayMs: -1 }));
    await expectRejects(() => make({ jitterMs: NaN }));
  });

  it("bounds the SUM, the operand setTimeout actually receives", async () => {
    // Each field is individually legal; `baseDelayMs + floor(rand()*jitterMs)`
    // is not. Before #102 this config collapsed to ~1ms on 11 of 12 runs and
    // honoured the delay on the twelfth — working or breaking on a jitter draw.
    await expectRejects(() => make({ baseDelayMs: MAX_TIMEOUT_MS - 50, jitterMs: 200 }));
    expect(
      await rejectionMessage(() => make({ baseDelayMs: MAX_TIMEOUT_MS - 50, jitterMs: 200 })),
    ).toMatch(/baseDelayMs \+ jitterMs/);
  });

  it("the sum bound is exact at the boundary, not conservative", async () => {
    await expectAccepts(() => make({ baseDelayMs: MAX_TIMEOUT_MS - 1, jitterMs: 1 }));
    await expectRejects(() => make({ baseDelayMs: MAX_TIMEOUT_MS - 1, jitterMs: 2 }));
  }, 10000);

  it(`names the interface in its message (${iface})`, async () => {
    expect(await rejectionMessage(() => make({ baseDelayMs: 2 ** 31 }))).toMatch(
      new RegExp(iface),
    );
  });
});

describe("the behaviour the guard now prevents", () => {
  it("2**31 - 1 is honoured: the stream stays pending", async () => {
    const r = await firstEvent(() => mockTextStream({ baseDelayMs: MAX_TIMEOUT_MS, jitterMs: 0 }), 150);
    expect(r).toBe("PENDING");
  }, 10000);

  it("a legal large delay is not silently instantaneous", async () => {
    // The regression this file exists for: without the upper bound, this same
    // shape at 2**31 fired in 0-4ms instead of staying pending.
    const r = await firstEvent(() => mockTextStream({ baseDelayMs: 2 ** 31 - 2, jitterMs: 0 }), 150);
    expect(r).toBe("PENDING");
  }, 10000);
});

describe("the premise: where Node's clamp actually is", () => {
  it.each([
    [2 ** 31 - 1, false],
    [2 ** 31, true],
    [Infinity, true],
    [NaN, true],
  ])("setTimeout(%d) clamps to ~1ms: %s", async (delay, expectClamped) => {
    const t0 = Date.now();
    const fired = await new Promise<boolean>((resolve) => {
      const id = setTimeout(() => resolve(true), delay as number);
      setTimeout(() => {
        clearTimeout(id);
        resolve(false);
      }, 120);
    });
    const elapsed = Date.now() - t0;
    if (expectClamped) {
      expect(fired).toBe(true);
      expect(elapsed).toBeLessThan(110);
    } else {
      expect(fired).toBe(false);
    }
  }, 10000);
});
