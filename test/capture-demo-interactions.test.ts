import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { assertMockMode, hasStarted, modeFromHtml, TOOL_CALL_PHASES } from "../scripts/capture_demo";

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

describe("the capture refuses a server that is not in mock mode (#146)", () => {
  it.each([
    ['<span data-stream-mode="mock">mock streamer</span>', "mock"],
    ['<span data-stream-mode="live">live: claude-haiku-4-5-20251001</span>', "live"],
    ["<span>mock streamer (set ANTHROPIC_API_KEY to switch to live)</span>", null],
    ['<i data-stream-mode="mock"></i><i data-stream-mode="mock"></i>', null],
    ["", null],
  ] as const)("modeFromHtml(%j) -> %s", (html, mode) => {
    expect(modeFromHtml(html)).toBe(mode);
  });

  it("only mock passes; live and an unreadable mode are refused with the restart command", () => {
    expect(() => assertMockMode("mock", "http://localhost:3000")).not.toThrow();
    for (const mode of ["live", null, "Mock", ""]) {
      expect(() => assertMockMode(mode, "http://localhost:3000")).toThrow(
        /not mock[\s\S]*env -u ANTHROPIC_API_KEY npm run dev/,
      );
    }
  });

  it("the page sets the attribute from getStreamMode(), the function that picks the streamer", () => {
    const page = read("app/streaming-text/page.tsx");
    expect(page).toContain("const mode = getStreamMode();");
    expect(page).toContain("<span data-stream-mode={mode.mode}>");
  });

  it("the check runs before a browser is launched, so it is not part of the video", () => {
    const src = read("scripts/capture_demo.ts");
    const body = src.slice(src.indexOf("async function runCapture"));
    const check = body.indexOf("assertMockMode(modeFromHtml(");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf("chromium.launch("));
  });
});
