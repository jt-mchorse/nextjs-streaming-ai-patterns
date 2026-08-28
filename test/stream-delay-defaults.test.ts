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

import { readdirSync, readFileSync } from "node:fs";
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

/**
 * Strip block and line comments before scanning source.
 *
 * Load-bearing, not cosmetic: all three modules *quote* the old `?? 0` / `?? 30`
 * shape in the prose explaining #110, so a scan of raw source flags the
 * explanation of the fix as the defect. Same reason — and same helper shape —
 * as `test/sse-framing-parity.test.ts`.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every `lib/` module with a delay seam, discovered rather than listed.
 *
 * A module qualifies if its *code* mentions `baseDelayMs` or `jitterMs`. That
 * is the property the rule is about, so it is the right partition: a fourth
 * mock streamer is in scope the moment it has the field, without anyone
 * remembering to add it here.
 */
function delaySeamModules(): string[] {
  const dir = join(process.cwd(), "lib");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && name !== "stream-delay.ts")
    .filter((name) => {
      const code = stripComments(readFileSync(join(dir, name), "utf8"));
      return /\bbaseDelayMs\b/.test(code) || /\bjitterMs\b/.test(code);
    })
    .sort();
}

/**
 * Every way a delay-seam module can reintroduce #110, as data.
 *
 * A predicate returning named violations rather than a series of inline
 * `expect`s, so the rule can be pointed at a *constructed* module — which is
 * what lets the anti-vacuous arms below prove it has teeth without committing a
 * deliberately broken file to `lib/`.
 */
function violationsOf(rawSrc: string): string[] {
  const code = stripComments(rawSrc);
  const problems: string[] = [];
  const once = (re: RegExp, label: string) => {
    if ((code.match(re) ?? []).length !== 1) problems.push(`does not declare ${label} exactly once`);
  };
  once(/const DEFAULT_BASE_DELAY_MS = \d+;/g, "DEFAULT_BASE_DELAY_MS");
  once(/const DEFAULT_JITTER_MS = \d+;/g, "DEFAULT_JITTER_MS");

  if (!/from "@\/lib\/stream-delay"/.test(code)) problems.push("does not import the shared guard");
  if (!/validateDelayOptions\(/.test(code)) problems.push("does not call validateDelayOptions");
  if (/const MAX_TIMEOUT_MS =/.test(code)) problems.push("declares its own MAX_TIMEOUT_MS");

  // Handed to the guard, and read by the generator, as the *same identifier*.
  if (!/baseDefault: DEFAULT_BASE_DELAY_MS/.test(code))
    problems.push("does not pass DEFAULT_BASE_DELAY_MS as baseDefault");
  if (!/jitterDefault: DEFAULT_JITTER_MS/.test(code))
    problems.push("does not pass DEFAULT_JITTER_MS as jitterDefault");
  if (!/options\.baseDelayMs \?\? DEFAULT_BASE_DELAY_MS/.test(code))
    problems.push("generator does not read DEFAULT_BASE_DELAY_MS");
  if (!/options\.jitterMs \?\? DEFAULT_JITTER_MS/.test(code))
    problems.push("generator does not read DEFAULT_JITTER_MS");

  // A `?? 30` anywhere is the shape that let the two drift apart.
  if (/options\.baseDelayMs \?\? \d/.test(code))
    problems.push("has a bare numeric fallback for baseDelayMs");
  if (/options\.jitterMs \?\? \d/.test(code))
    problems.push("has a bare numeric fallback for jitterMs");

  return problems;
}

describe("structural: one spelling per default", () => {
  it("the discovery finds the delay-seam modules, and finds some", () => {
    // Anti-vacuous, and the whole point of #112: every assertion below is a
    // loop over this list, so a discovery that returned `[]` would pass all of
    // them. Before #112 the list was three literals and a fourth module was not
    // checked — it was not *seen*.
    const found = delaySeamModules();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(
      expect.arrayContaining(["mock-stream.ts", "mock-json-stream.ts", "mock-tool-stream.ts"]),
    );
  });

  it("the behavioural table covers every discovered module", () => {
    // `describe.each(STREAMS)` stays table-driven because it needs each
    // module's documented default *values* (30/30, 80/40, 30/30), which cannot
    // be read off disk. So the table is pinned to the discovery instead: a new
    // delay-seam module fails here until someone gives it its numbers.
    expect(STREAMS.map(([, file]) => file).sort()).toEqual(delaySeamModules());
  });

  it.each(delaySeamModules())("%s satisfies every rule, with no violations", (file) => {
    // The defect was one quantity with two spellings. This is the lock that a
    // fourth copy — or a future edit to any of them — cannot reintroduce the
    // split. It is a source check because the constants are module-private by
    // design.
    expect(violationsOf(readFileSync(join(process.cwd(), "lib", file), "utf8"))).toEqual([]);
  });

  it("a module re-inlining the #110 split is actually caught", () => {
    // The arm that makes every assertion above mean something. `toEqual([])`
    // over a discovered list passes when the list is empty *and* when the rule
    // is toothless; this proves the rule has teeth, and names which teeth.
    //
    // The fixture is the measured reproduction from #112, verbatim: guard
    // defaults to 0, generator defaults to 30. Held as a string rather than a
    // committed module so the repo does not ship a broken streamer.
    const fourthCopy = [
      'import { MAX_TIMEOUT_MS } from "@/lib/stream-delay";',
      "export async function* mockProbeStream(options: { baseDelayMs?: number; jitterMs?: number } = {}) {",
      "  const maxDelay = (options.baseDelayMs ?? 0) + (options.jitterMs ?? 0);",
      '  if (maxDelay > MAX_TIMEOUT_MS) throw new RangeError("nope");',
      "  const base = options.baseDelayMs ?? 30;",
      "  const jitter = options.jitterMs ?? 30;",
      "  yield { delay: base + Math.floor(Math.random() * jitter) };",
      "}",
    ].join("\n");

    const violations = violationsOf(fourthCopy);
    expect(violations).toContain("does not declare DEFAULT_BASE_DELAY_MS exactly once");
    expect(violations).toContain("does not declare DEFAULT_JITTER_MS exactly once");
    expect(violations).toContain("does not call validateDelayOptions");
    expect(violations).toContain("has a bare numeric fallback for baseDelayMs");
    expect(violations).toContain("has a bare numeric fallback for jitterMs");
  });

  it("a compliant module produces no violations, so the rule is not simply always-on", () => {
    // The other direction of the same worry: a predicate that flagged
    // everything would also make `toEqual([])` above meaningless — it would
    // just be failing for all modules. Built from the shape the three real
    // streamers use.
    const compliant = [
      'import { validateDelayOptions } from "@/lib/stream-delay";',
      "const DEFAULT_BASE_DELAY_MS = 30;",
      "const DEFAULT_JITTER_MS = 30;",
      "export async function* s(options: { baseDelayMs?: number; jitterMs?: number } = {}) {",
      '  validateDelayOptions(options, { label: "X", baseDefault: DEFAULT_BASE_DELAY_MS, jitterDefault: DEFAULT_JITTER_MS });',
      "  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;",
      "  const jitter = options.jitterMs ?? DEFAULT_JITTER_MS;",
      "  yield base + jitter;",
      "}",
    ].join("\n");
    expect(violationsOf(compliant)).toEqual([]);
  });

  it("comment-stripping neutralizes a quoted old shape", () => {
    // I first wrote this asserting that the three streamers quote the old
    // `?? 0` shape in their #110 prose. They don't — only `stream-delay.ts`
    // does, and that file is excluded from the scan — so the assertion was
    // false about this tree and the test caught it. Kept, reframed to prove the
    // *mechanism* on a constructed input instead: the scan must not be
    // trippable by prose, which is exactly the failure mode that would make a
    // future explanatory comment look like the defect.
    const withProseOnly = [
      "// The bug was `options.baseDelayMs ?? 0` here.",
      "/* and `options.jitterMs ?? 30` there. */",
      "const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;",
    ].join("\n");
    expect(/options\.baseDelayMs \?\? \d/.test(withProseOnly)).toBe(true);
    expect(stripComments(withProseOnly)).not.toMatch(/options\.baseDelayMs \?\? \d/);
    expect(stripComments(withProseOnly)).not.toMatch(/options\.jitterMs \?\? \d/);
    // ...and it must not eat real code while doing it.
    expect(stripComments(withProseOnly)).toMatch(
      /options\.baseDelayMs \?\? DEFAULT_BASE_DELAY_MS/,
    );
  });

  it("stream-delay.ts is excluded deliberately, and is the one file that needs to be", () => {
    // The shared guard cannot be required to import itself, and it legitimately
    // quotes `?? 0` while documenting the bug. Asserting the exclusion is
    // narrow stops it from quietly becoming a place to hide a module.
    const guard = readFileSync(join(process.cwd(), "lib", "stream-delay.ts"), "utf8");
    expect(guard).toMatch(/\bbaseDelayMs\b/);
    expect(delaySeamModules()).not.toContain("stream-delay.ts");
    expect(delaySeamModules().length).toBeGreaterThanOrEqual(3);
  });
});
