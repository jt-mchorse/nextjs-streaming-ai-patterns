import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hasStarted, TOOL_CALL_PHASES } from "../scripts/capture_demo";

/**
 * The capture's interactions wait on the page's own phase, not on timers (#144).
 *
 * `npm run capture` could not finish: it clicked Interrupt 4.5 s after Run on a
 * ~2.2 s mock stream (Interrupt was always disabled by then), its Run click
 * could land before hydration, and `/partial-json` -- documented as
 * auto-starting -- never started. The fix keys every step on the `phase:`
 * readout the components render. The full tour was run end to end against a
 * dev server for the PR; these arms pin the pieces that need no browser, and
 * the component facts the script now depends on.
 */

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("hasStarted", () => {
  it.each([
    ["idle", false],
    ["  idle  ", false],
    ["", false],
    [null, false],
    ["connecting", true],
    ["streaming", true],
    ["tool_called", true],
    ["done", true],
  ] as const)("%j -> %s", (phase, started) => {
    expect(hasStarted(phase)).toBe(started);
  });
});

describe("the component facts the script relies on", () => {
  const toolUse = read("components/tool-use-client.tsx");

  it("every TOOL_CALL_PHASES entry is a tool-use Phase in which Interrupt is enabled", () => {
    const union = toolUse.match(/type Phase =([\s\S]*?);/);
    expect(union).not.toBeNull();
    const phases = [...union![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const streaming = toolUse.match(/const isStreaming =([\s\S]*?);/);
    expect(streaming).not.toBeNull();
    const enabledIn = [...streaming![1].matchAll(/phase === "([a-z_]+)"/g)].map((m) => m[1]);
    expect(TOOL_CALL_PHASES.length).toBeGreaterThan(0);
    for (const p of TOOL_CALL_PHASES) {
      expect(phases, `${p} is not a tool-use Phase`).toContain(p);
      expect(enabledIn, `Interrupt is disabled in ${p}`).toContain(p);
    }
  });

  it("partial-json still has no start-on-mount, so the capture must click it", () => {
    // If this changes, the capture's "Plan a trip" click becomes a second run.
    const pj = read("components/partial-json-client.tsx");
    const effects = [...pj.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
    expect(effects.length).toBeGreaterThan(0); // the scan sees the teardown effect
    expect(effects.every((body) => !/\brun\(/.test(body))).toBe(true);
    expect(read("scripts/capture_demo.ts")).toContain('name: "Plan a trip"');
  });
});
