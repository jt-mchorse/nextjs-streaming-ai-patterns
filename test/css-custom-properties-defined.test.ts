/**
 * Every CSS custom property the UI reads is one `app/globals.css` defines (#219).
 *
 * `components/tool-use-client.tsx` styled its error banner with
 * `border-[var(--err)] bg-[var(--err-bg)] text-[var(--err)]`, its text cards
 * with `--card`, its tool card with `--accent-bg` and its Interrupt button
 * with `--fg`. `globals.css` defined none of the five. An undefined custom
 * property makes the declaration invalid at computed-value time, so each
 * property fell back to its inherited or initial value: measured in Chromium
 * on `/tool-use` with a stream ending in `event: error`, the banner computed
 * to `color rgb(237, 237, 237)`, background `rgba(0, 0, 0, 0)`, border
 * `rgb(237, 237, 237)` — body white-on-black, indistinguishable from a text
 * card. Nothing fails loudly: Tailwind emits the arbitrary-value class either
 * way and the browser drops it silently.
 *
 * The population is every `var(--x)` in shipped source (`readSourceFiles`,
 * comments stripped) plus `globals.css` itself, not a list of the five names,
 * so the next misspelt or forgotten token is caught too. A `var(--x, fallback)`
 * still counts as a use: the issue is a token the palette does not own.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ROOT, readSourceFiles, stripComments } from "./support/source-files";

const GLOBALS = "app/globals.css";

function cssText(): string {
  return stripComments(readFileSync(join(ROOT, GLOBALS), "utf8"));
}

/** Custom properties declared in *css*, name → raw value. */
function definitions(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;}]+)/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

/** Every `var(--x` in *src*, as the set of names. */
function uses(src: string): Set<string> {
  return new Set(Array.from(src.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g), (m) => m[1]));
}

/** `[file, name]` for every use in *corpus* that *defs* does not define. */
function undefinedUses(
  corpus: Array<readonly [string, string]>,
  defs: Map<string, string>,
): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const [file, src] of corpus) {
    for (const name of uses(src)) if (!defs.has(name)) out.push([file, name]);
  }
  return out;
}

function corpus(): Array<readonly [string, string]> {
  return [
    ...readSourceFiles().map(([f, s]) => [f, stripComments(s)] as const),
    [GLOBALS, cssText()] as const,
  ];
}

/** Follow `var(--x)` aliases to a literal value. */
function resolveToken(defs: Map<string, string>, name: string, depth = 0): string | undefined {
  const raw = defs.get(name);
  if (raw === undefined || depth > 8) return undefined;
  const alias = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(raw);
  return alias ? resolveToken(defs, alias[1], depth + 1) : raw;
}

function hexRgb(value: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

describe("CSS custom properties are defined (#219)", () => {
  it("every var(--x) under components/ and app/ is defined in globals.css", () => {
    expect(undefinedUses(corpus(), definitions(cssText()))).toEqual([]);
  });

  it("--err resolves to a red that is not the body colour", () => {
    const defs = definitions(cssText());
    const err = resolveToken(defs, "--err");
    const fg = resolveToken(defs, "--foreground");
    expect(err).toBeDefined();
    expect(err).not.toBe(fg);
    const rgb = hexRgb(err!);
    expect(rgb, `--err is ${err}, expected a #rrggbb literal`).toBeDefined();
    const [r, g, b] = rgb!;
    expect(r - Math.max(g, b)).toBeGreaterThan(80);
  });

  // Controls: the lock is only as good as its population and its parser.

  it("control: the scan reaches tool-use-client.tsx and reads its tokens", () => {
    const tool = corpus().find(([f]) => f === "components/tool-use-client.tsx");
    expect(tool).toBeDefined();
    expect(uses(tool![1])).toContain("--accent");
    expect(uses(tool![1])).toContain("--err");
  });

  it("control: the definition parser sees the base palette", () => {
    const defs = definitions(cssText());
    for (const name of ["--background", "--foreground", "--accent", "--muted", "--panel", "--border"]) {
      expect(defs.has(name), name).toBe(true);
    }
  });

  it("control: a planted undefined token is reported", () => {
    const defs = definitions(":root { --a: #000; }");
    expect(
      undefinedUses([["x.tsx", 'className="text-[var(--a)] bg-[var(--b,red)]"']], defs),
    ).toEqual([["x.tsx", "--b"]]);
  });
});
