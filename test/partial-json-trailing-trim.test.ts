import { describe, expect, it } from "vitest";

import { parsePartialJson, trimTrailingSeparators } from "../lib/partial-json";

// #214: `frameSnapshot` trimmed the repaired prefix with `/[ \t\n\r,]+$/`. On a
// long run of those characters in the MIDDLE of the prefix the regex engine
// starts a match at every position in the run, scans to its end, and fails --
// quadratic per parse, and the client re-parses the whole buffer on every chunk.
// Measured on 3d76724 with a 40k run: 1310 ms (spaces), 2274 ms (newlines),
// 3574 ms (commas inside a committed string). The backward loop that replaced
// it must give the same output and touch only the trailing run.

/** The trim as it shipped before #214 -- the reference for equivalence. */
const OLD_REGEX_TRIM = (s: string): string => s.replace(/[ \t\n\r,]+$/, "");

describe("trimTrailingSeparators is output-equivalent to the old regex (#214)", () => {
  // Mixed tails: empty, all-trim, interior runs that must survive, each of the
  // five trimmed characters on its own, and characters that must NOT be trimmed
  // -- the non-JSON whitespace #181 excluded, and a `,` or space inside a string
  // that ends the prefix with its closing quote.
  const cases: ReadonlyArray<string> = [
    "",
    " ",
    ",",
    " \t\n\r,",
    ",,, \n\n,",
    '{"a":1',
    '{"a":1,',
    '{"a":1, ',
    '{"a":1,\t\r\n ,',
    '{"a":1,     "b":2',
    '{"a":1,     "b":2,  \n',
    '{"a":",,,,  "',
    '{"a":",,,,  ",',
    "[1,2,3",
    "[1,2,3,\n",
    `{"a":1,${String.fromCodePoint(0xa0)}`,
    `{"a":1,${String.fromCodePoint(0x0b)}`,
    `{"a":1,${String.fromCodePoint(0x0c)} ,`,
    `[1,${String.fromCodePoint(0x2028)}`,
    `[1,${String.fromCodePoint(0xfeff)},`,
    "x",
    "x\n",
    "\nx",
  ];

  for (const input of cases) {
    it(`matches the old regex on ${JSON.stringify(input)}`, () => {
      expect(trimTrailingSeparators(input)).toBe(OLD_REGEX_TRIM(input));
    });
  }

  it("matches the old regex on every string over a small alphabet up to length 5", () => {
    // Exhaustive rather than hand-picked: the five trimmed characters, a
    // non-JSON space, and two structural characters, in every arrangement.
    const alphabet = [" ", "\t", "\n", "\r", ",", String.fromCodePoint(0xa0), "1", '"'];
    let checked = 0;
    const walk = (s: string): void => {
      expect(trimTrailingSeparators(s), JSON.stringify(s)).toBe(OLD_REGEX_TRIM(s));
      checked += 1;
      if (s.length === 5) return;
      for (const c of alphabet) walk(s + c);
    };
    walk("");
    // 1 + 8 + 8^2 + ... + 8^5 -- the walk actually ran.
    expect(checked).toBe(37449);
  });
});

describe("trimTrailingSeparators visits only the trailing run (#214)", () => {
  /** Wrap `s` so every indexed character read is counted. Non-index property
   *  reads (`length`, `slice`) pass through, bound to the underlying string. */
  function counted(s: string): { str: string; reads: () => number } {
    let n = 0;
    const target = new String(s);
    const proxy = new Proxy(target, {
      get(t, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) n += 1;
        const v = Reflect.get(t, key, t) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
      },
    });
    return { str: proxy as unknown as string, reads: () => n };
  }

  it("reads the trailing run plus one character, however long the interior run is", () => {
    const interior = " \n,".repeat(50_000);
    const tail = " ,\n\t";
    const { str, reads } = counted(`{"a":1,${interior}"b":2${tail}`);
    expect(trimTrailingSeparators(str)).toBe(`{"a":1,${interior}"b":2`);
    // The lower bound is the anti-vacuity arm: a trim that never indexed the
    // string (a regex reimplementation, say) would read 0 characters and pass
    // an upper bound alone.
    expect(reads()).toBeGreaterThanOrEqual(tail.length);
    expect(reads()).toBeLessThanOrEqual(tail.length + 1);
  });
});

describe("parsePartialJson stays linear on a long interior separator run (#214)", () => {
  // Wall-clock, but with a bound far from both sides: on 3d76724 these inputs
  // took ~8-22 s at this size (and 1.3-3.6 s at 40k); after the fix each parse
  // is single-digit milliseconds. The bound only has to separate those.
  const N = 100_000;
  const BOUND_MS = 1000;
  const shapes: ReadonlyArray<[string, string, unknown]> = [
    ["spaces between fields", `{"a":1,${" ".repeat(N)}"b":2,"c":`, { a: 1, b: 2 }],
    ["newlines between fields", `{"a":1,${"\n".repeat(N)}"b":2,"c":`, { a: 1, b: 2 }],
    ["commas inside a committed string", `{"a":"${",".repeat(N)}x","b":`, { a: `${",".repeat(N)}x` }],
  ];

  for (const [name, input, expected] of shapes) {
    it(
      `parses ${N.toLocaleString("en-US")} ${name} in under ${BOUND_MS} ms`,
      () => {
        const t0 = performance.now();
        const { value, isComplete } = parsePartialJson(input);
        const ms = performance.now() - t0;
        expect(value).toEqual(expected);
        expect(isComplete).toBe(false);
        expect(ms, `took ${ms.toFixed(0)} ms`).toBeLessThan(BOUND_MS);
      },
      // Long enough that the unfixed code fails on the bound, with its
      // measured time in the message, rather than on the runner's timeout.
      120_000,
    );
  }

  it("control: the same run in a complete document takes the fast path", () => {
    const input = `{"a":1,${" ".repeat(N)}"b":2}`;
    const t0 = performance.now();
    const { value, isComplete } = parsePartialJson(input);
    const ms = performance.now() - t0;
    expect(value).toEqual({ a: 1, b: 2 });
    expect(isComplete).toBe(true);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});
