/**
 * The sum guard defaulted an omitted field to 0; the generator defaults it to a
 * real delay (#110).
 *
 * `#102` bounded the mock streamers' delays because `setTimeout` clamps anything
 * over `2**31 - 1` to 1 ms -- ask for a deliberately slow stream, get an
 * instantaneous one. Its second guard, for the sum, states the hazard exactly:
 *
 *     `setTimeout` receives `baseDelayMs + floor(rand() * jitterMs)`, not either
 *     field alone, so the two checks above can both pass while the value that
 *     actually reaches the timer is over the clamp.
 *
 * The guard it wrote did not model that value:
 *
 *     const maxDelay = (options.baseDelayMs ?? 0) + (options.jitterMs ?? 0);  // guard
 *     const baseDelayMs = options.baseDelayMs ?? 30;                          // runtime
 *
 * So with a field omitted the guard checked a smaller number than the one that
 * reached the timer, and approved exactly the config that overflows. Measured on
 * the real modules, first event with a 250 ms budget:
 *
 *     mockTextStream({ baseDelayMs: 2**31 - 1 })   validator PASSES -> 3 ms
 *     mockJsonStream({ baseDelayMs: 2**31 - 1 })   validator PASSES -> 1 ms
 *
 * for a requested delay of ~24.8 days, with a `TimeoutOverflowWarning` on stderr
 * as the only signal.
 *
 * `test/mock-stream-timeout-clamp.test.ts` exists for this guard and did not
 * catch it, because every boundary case in it passes BOTH fields -- and with
 * both present, `?? 0` and `?? 30` are the same expression. The one shape that
 * distinguishes them is an omitted field, and that is the shape it never tried.
 * A test is only as wide as the input *shapes* it constructs.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mockJsonStream } from "@/lib/mock-json-stream";
import { mockTextStream } from "@/lib/mock-stream";
import { mockToolStream } from "@/lib/mock-tool-stream";
import { MAX_TIMEOUT_MS, validateDelayOptions } from "@/lib/stream-delay";

/**
 * Each module's documented defaults, carried here as data. These are the
 * numbers the options-interface docstrings promise ("Default 30." / "Default
 * 80."), so asserting the guard agrees with them is asserting the guard agrees
 * with the generator -- the exact identity #110 restores.
 */
const STREAMS = [
  ["mockTextStream", "mock-stream.ts", 30, 30, (o: object) => mockTextStream(o)],
  ["mockJsonStream", "mock-json-stream.ts", 80, 40, (o: object) => mockJsonStream(o)],
  ["mockToolStream", "mock-tool-stream.ts", 30, 30, (o: object) => mockToolStream(o)],
] as const;

/**
 * These are async *generators*: calling one only constructs it, so
 * `validateOptions` does not run until the first `next()`. Same idiom as
 * `test/mock-stream-timeout-clamp.test.ts`.
 */
async function rejects(make: () => AsyncGenerator<unknown>): Promise<boolean> {
  // Raced against a short timer, the same idiom `mock-stream-timeout-clamp.ts`
  // uses: an ACCEPTED config with a near-clamp delay parks in a real ~24.8-day
  // `sleep`, so awaiting `next()` outright would hang the test rather than pass
  // it. `validateOptions` runs at the top of the generator body, so a rejection
  // always resolves before the timer.
  const gen = make();
  const outcome = await Promise.race([
    gen.next().then(
      () => "stepped" as const,
      (e: unknown) => e,
    ),
    new Promise<"PENDING">((r) => setTimeout(() => r("PENDING"), 60)),
  ]);
  return outcome instanceof RangeError;
}

describe.each(STREAMS)(
  "%s: an omitted delay field is validated against the default the generator uses",
  (_name, _file, baseDefault, jitterDefault, make) => {
    it("rejects baseDelayMs at the clamp when jitterMs is omitted", async () => {
      // Before #110 this PASSED, and the generator then computed
      // MAX + floor(rand() * jitterDefault), overflowing on all but one draw in
      // `jitterDefault`.
      expect(await rejects(() => make({ baseDelayMs: MAX_TIMEOUT_MS }))).toBe(true);
    });

    it("rejects jitterMs at the clamp when baseDelayMs is omitted", async () => {
      expect(await rejects(() => make({ jitterMs: MAX_TIMEOUT_MS }))).toBe(true);
    });

    it("the boundary is exactly the generator's jitter default", async () => {
      // The largest baseDelayMs that can be safe with jitterMs omitted is
      // MAX - jitterDefault. One more overflows. This is what pins the guard to
      // the generator's number rather than to any number.
      expect(await rejects(() => make({ baseDelayMs: MAX_TIMEOUT_MS - jitterDefault }))).toBe(
        false,
      );
      expect(await rejects(() => make({ baseDelayMs: MAX_TIMEOUT_MS - jitterDefault + 1 }))).toBe(
        true,
      );
    }, 10000);

    it("the boundary is exactly the generator's base default, the other way round", async () => {
      expect(await rejects(() => make({ jitterMs: MAX_TIMEOUT_MS - baseDefault }))).toBe(false);
      expect(await rejects(() => make({ jitterMs: MAX_TIMEOUT_MS - baseDefault + 1 }))).toBe(true);
    }, 10000);

    it("ordinary and empty configs are unaffected", async () => {
      expect(await rejects(() => make({}))).toBe(false);
      expect(await rejects(() => make({ baseDelayMs: 30, jitterMs: 30 }))).toBe(false);
      expect(await rejects(() => make({ baseDelayMs: 0 }))).toBe(false);
      expect(await rejects(() => make({ jitterMs: 0 }))).toBe(false);
    }, 10000);
  },
);

describe("the shared guard itself", () => {
  it("uses the caller's defaults for an omitted field, not zero", () => {
    const defaults = { label: "X", baseDefault: 30, jitterDefault: 30 };
    expect(() => validateDelayOptions({ baseDelayMs: MAX_TIMEOUT_MS }, defaults)).toThrow(
      RangeError,
    );
    expect(() => validateDelayOptions({ baseDelayMs: MAX_TIMEOUT_MS - 30 }, defaults)).not.toThrow();
  });

  it("zero defaults still behave as before, so the change is in the caller not the rule", () => {
    const zeroed = { label: "X", baseDefault: 0, jitterDefault: 0 };
    expect(() => validateDelayOptions({ baseDelayMs: MAX_TIMEOUT_MS }, zeroed)).not.toThrow();
  });

  it("names the caller's label in every message", () => {
    const defaults = { label: "WidgetOptions", baseDefault: 30, jitterDefault: 30 };
    for (const opts of [{ baseDelayMs: NaN }, { baseDelayMs: 2 ** 31 }, { jitterMs: 2 ** 31 }]) {
      expect(() => validateDelayOptions(opts, defaults)).toThrow(/WidgetOptions/);
    }
    expect(() => validateDelayOptions({ baseDelayMs: MAX_TIMEOUT_MS }, defaults)).toThrow(
      /WidgetOptions: baseDelayMs \+ jitterMs/,
    );
  });
});

describe("structural: one spelling per default", () => {
  it.each(STREAMS.map(([, file]) => file))(
    "%s reads its defaults from named constants in both places",
    (file) => {
      // The defect was one quantity with two spellings. This is the lock that a
      // fourth copy -- or a future edit to one of these three -- cannot
      // reintroduce the split, and it is a source check because the constants
      // are module-private by design.
      const src = readFileSync(join(process.cwd(), "lib", file), "utf8");

      // Declared exactly once each.
      expect(src.match(/const DEFAULT_BASE_DELAY_MS = \d+;/g)).toHaveLength(1);
      expect(src.match(/const DEFAULT_JITTER_MS = \d+;/g)).toHaveLength(1);

      // Handed to the guard...
      expect(src).toMatch(/baseDefault: DEFAULT_BASE_DELAY_MS/);
      expect(src).toMatch(/jitterDefault: DEFAULT_JITTER_MS/);

      // ...and read by the generator, as the same identifier.
      expect(src).toMatch(/options\.baseDelayMs \?\? DEFAULT_BASE_DELAY_MS/);
      expect(src).toMatch(/options\.jitterMs \?\? DEFAULT_JITTER_MS/);

      // And no bare numeric fallback survives for either delay field -- a
      // `?? 30` anywhere is the shape that let the two drift apart.
      expect(src).not.toMatch(/options\.baseDelayMs \?\? \d/);
      expect(src).not.toMatch(/options\.jitterMs \?\? \d/);
    },
  );

  it("the guard lives in one place", () => {
    // Three inlined copies is what made one edit fix one of them. If a module
    // grows its own MAX_TIMEOUT_MS again, this fails.
    for (const [, file] of STREAMS) {
      const src = readFileSync(join(process.cwd(), "lib", file), "utf8");
      expect(src).toMatch(/from "@\/lib\/stream-delay"/);
      expect(src).not.toMatch(/const MAX_TIMEOUT_MS =/);
    }
  });
});
