/**
 * `readOptions` value-domain lock for `scripts/capture_demo.ts` (#104).
 *
 * Three environment variables, none of them covered before this file:
 * `test/capture-demo-smoke.test.ts` validates `TIMELINE` against
 * `app/page.tsx` and never calls `readOptions`, which was not even exported.
 * The script's own header docstring claimed "smoke test passes 0" for
 * `CAPTURE_PACE_MS`; nothing in `test/` referenced it.
 *
 * What was measured on `main`:
 *
 *     CAPTURE_PACE_MS  Number.parseInt(raw, 10)   result
 *     "1e3"            1                          1000x LOW
 *     "1_000"          1                          1000x LOW
 *     "12,000"         12                         1000x LOW
 *     "250abc"         250                        accepted silently
 *     "0x10"           0
 *     "3.9"            3                          truncated, not rejected
 *
 * `1e3` and `1_000` are the two natural spellings of "one thousand
 * milliseconds", in the one knob whose entire job is to slow interactions
 * down enough to be visible on camera. A 1000x error there produces unusable
 * footage with nothing in the log to say why.
 *
 *     CAPTURE_BASE_URL   new URL("/stream-text", baseUrl)
 *     ""                 TypeError: Invalid URL      <- `??` does not default ""
 *     "localhost:3000"   TypeError: Invalid URL      <- missing scheme
 *
 * and that `TypeError` was thrown inside `runCapture`'s loop, i.e. *after*
 * `chromium.launch()` and `context.newPage()` — a live browser and an open
 * recording context, with nothing in the message naming the variable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_URL,
  DEFAULT_OUT_PATH,
  DEFAULT_PACE_MS,
  readOptions,
} from "../scripts/capture_demo";

const VARS = ["CAPTURE_PACE_MS", "CAPTURE_BASE_URL", "CAPTURE_OUT", "CAPTURE_HEADED"] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("CAPTURE_PACE_MS", () => {
  // The rows that used to be accepted as something other than what they say.
  it.each([
    ["1e3", "the exponent form of 1000"],
    ["1_000", "the separator form of 1000"],
    ["12,000", "the comma form of 12000"],
    ["250abc", "a numeric prefix with trailing junk"],
    ["0x10", "hex"],
    ["3.9", "a non-integer"],
    [".5", "a bare fraction"],
    ["1e-3", "a negative exponent"],
  ])("rejects %j (%s)", (raw) => {
    process.env.CAPTURE_PACE_MS = raw;
    expect(() => readOptions([])).toThrow(/CAPTURE_PACE_MS must be a non-negative integer/);
  });

  it("names the two spellings that used to be read as 1ms", () => {
    process.env.CAPTURE_PACE_MS = "1e3";
    // The message has to be actionable: someone who wrote 1e3 meant 1000, and
    // "invalid" alone leaves them guessing which of the two is wrong.
    expect(() => readOptions([])).toThrow(/write 1000, not 1e3 or 1_000/);
  });

  // Rows that were rejected before and must stay rejected.
  it.each([["-5"], ["abc"], ["Infinity"], ["NaN"], ["-0.1"]])("rejects %j", (raw) => {
    process.env.CAPTURE_PACE_MS = raw;
    expect(() => readOptions([])).toThrow(/CAPTURE_PACE_MS/);
  });

  // Rows that were accepted before and must stay accepted — a value-domain
  // fix that over-rejects is a different bug, not a stricter one.
  it.each([
    ["250", 250],
    ["  250  ", 250],
    ["0", 0],
    ["+250", 250],
    ["1000", 1000],
  ])("accepts %j as %i", (raw, expected) => {
    process.env.CAPTURE_PACE_MS = raw;
    expect(readOptions([]).paceMs).toBe(expected);
  });

  it.each([["", "empty"], ["   ", "whitespace-only"]])(
    "treats a %s value as unset and uses the default",
    (raw) => {
      process.env.CAPTURE_PACE_MS = raw;
      expect(readOptions([]).paceMs).toBe(DEFAULT_PACE_MS);
    },
  );

  it("uses the default when the variable is absent", () => {
    expect(readOptions([]).paceMs).toBe(DEFAULT_PACE_MS);
  });
});

describe("CAPTURE_BASE_URL", () => {
  it.each([["", "empty"], ["   ", "whitespace-only"]])(
    "treats a %s value as unset (`??` does not default an empty string)",
    (raw) => {
      process.env.CAPTURE_BASE_URL = raw;
      expect(readOptions([]).baseUrl).toBe(DEFAULT_BASE_URL);
    },
  );

  it.each([["not a url"], ["localhost:3000"], ["/relative/only"], ["://nope"]])(
    "rejects %j before a browser could be launched",
    (raw) => {
      process.env.CAPTURE_BASE_URL = raw;
      expect(() => readOptions([])).toThrow(/CAPTURE_BASE_URL must be an absolute URL/);
    },
  );

  it("suggests the missing scheme for a host:port typo", () => {
    process.env.CAPTURE_BASE_URL = "localhost:3000";
    expect(() => readOptions([])).toThrow(/try http:\/\/localhost:3000/);
  });

  it.each([
    ["http://localhost:3000"],
    ["http://localhost:3000/"],
    ["https://demo.example.com"],
    ["http://127.0.0.1:4000/base/"],
  ])("accepts %j", (raw) => {
    process.env.CAPTURE_BASE_URL = raw;
    expect(readOptions([]).baseUrl).toBe(raw);
  });

  it("produces a base URL that the capture loop can actually resolve slugs against", () => {
    // The property that matters is not "parses" but "resolves the slugs the
    // TIMELINE holds" — which is where the raw TypeError used to surface.
    process.env.CAPTURE_BASE_URL = "http://127.0.0.1:4000";
    const { baseUrl } = readOptions([]);
    expect(new URL("/error-recovery", baseUrl).toString()).toBe(
      "http://127.0.0.1:4000/error-recovery",
    );
  });
});

describe("CAPTURE_OUT", () => {
  it.each([["", "empty"], ["   ", "whitespace-only"]])(
    "treats a %s value as unset, so the closing instruction names a real path",
    (raw) => {
      // `dirname("")` is ".", so an empty value recorded into the repository
      // root and the final log line read "move/rename it to " with nothing
      // after it.
      process.env.CAPTURE_OUT = raw;
      expect(readOptions([]).outPath).toBe(DEFAULT_OUT_PATH);
    },
  );

  it("passes a supplied path through unchanged", () => {
    process.env.CAPTURE_OUT = "docs/demo-2.webm";
    expect(readOptions([]).outPath).toBe("docs/demo-2.webm");
  });

  it("trims surrounding whitespace rather than creating a directory named ' docs'", () => {
    process.env.CAPTURE_OUT = "  docs/demo-2.webm  ";
    expect(readOptions([]).outPath).toBe("docs/demo-2.webm");
  });
});

describe("--headed / CAPTURE_HEADED", () => {
  it("is off by default", () => {
    expect(readOptions([]).headed).toBe(false);
  });

  it("is on via the flag", () => {
    expect(readOptions(["--headed"]).headed).toBe(true);
  });

  it("is on via CAPTURE_HEADED=1", () => {
    process.env.CAPTURE_HEADED = "1";
    expect(readOptions([]).headed).toBe(true);
  });

  it.each([["0"], ["true"], [""], ["yes"]])(
    "is off for CAPTURE_HEADED=%j — the strict === '1' comparison is deliberate",
    (raw) => {
      process.env.CAPTURE_HEADED = raw;
      expect(readOptions([]).headed).toBe(false);
    },
  );
});

describe("the header docstring matches what is enforced", () => {
  it("documents the defaults it actually uses", () => {
    expect(DEFAULT_BASE_URL).toBe("http://localhost:3000");
    expect(DEFAULT_OUT_PATH).toBe("docs/demo.webm");
    expect(DEFAULT_PACE_MS).toBe(250);
  });
});
