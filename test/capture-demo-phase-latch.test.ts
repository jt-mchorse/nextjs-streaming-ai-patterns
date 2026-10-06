import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformSync } from "esbuild";

import { installPhaseLatch, TOOL_CALL_PHASES } from "../scripts/capture_demo";

/**
 * The /tool-use step latches the tool phase instead of polling for it (#148).
 *
 * The tool-call phases are on screen for ~240 ms. `locator.waitFor` checks on
 * Playwright's backoff (+0, 20, 70, 170, 270, 770 ms, then every 500 ms), so a
 * window between two checks was never seen: five takes against a freshly
 * started `next dev` all timed out at /tool-use, and three with the latch all
 * completed. These arms run `installPhaseLatch` -- the function the page runs
 * -- against a minimal DOM, compile it the way tsx does, and pin where the
 * script installs it.
 */

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

type Latched = { __capturePhaseLatched?: boolean };
const g = globalThis as unknown as Record<string, unknown> & Latched;

/** A `phase` readout and a MutationObserver that fires when the test says so. */
function fakePage(initial: string) {
  const code = { textContent: initial };
  const observers: Array<{ cb: () => void; live: boolean }> = [];
  g.document = {
    body: {},
    querySelector: (sel: string) => (sel === '[data-testid="phase"] code' ? code : null),
  };
  g.MutationObserver = class {
    private entry: { cb: () => void; live: boolean };
    constructor(cb: () => void) {
      this.entry = { cb, live: false };
      observers.push(this.entry);
    }
    observe() {
      this.entry.live = true;
    }
    disconnect() {
      this.entry.live = false;
    }
  };
  return {
    show(text: string) {
      code.textContent = text;
      for (const o of observers) if (o.live) o.cb();
    },
    live: () => observers.filter((o) => o.live).length,
  };
}

afterEach(() => {
  delete g.document;
  delete g.MutationObserver;
  delete g.__capturePhaseLatched;
});

describe("installPhaseLatch (#148)", () => {
  it("stays false through the phases before the tool call", () => {
    const page = fakePage("idle");
    installPhaseLatch(TOOL_CALL_PHASES);
    for (const p of ["connecting", "streaming_text"]) page.show(p);
    expect(g.__capturePhaseLatched).toBe(false);
    expect(page.live()).toBe(1);
  });

  it("latches on a tool phase shown for a single mutation and stays latched after it", () => {
    const page = fakePage("idle");
    installPhaseLatch(TOOL_CALL_PHASES);
    page.show("connecting");
    page.show("tool_called");
    // The window closes before anyone looks: the latch must still say yes.
    for (const p of ["streaming_text", "done"]) page.show(p);
    expect(g.__capturePhaseLatched).toBe(true);
    expect(page.live()).toBe(0);
  });

  it.each(TOOL_CALL_PHASES.map((p) => [p]))("any tool phase latches it: %s", (p) => {
    const page = fakePage("idle");
    installPhaseLatch(TOOL_CALL_PHASES);
    page.show(`  ${p}\n`);
    expect(g.__capturePhaseLatched).toBe(true);
  });

  it("resets a latch left over from an earlier take", () => {
    fakePage("idle");
    g.__capturePhaseLatched = true;
    installPhaseLatch(TOOL_CALL_PHASES);
    expect(g.__capturePhaseLatched).toBe(false);
  });

  it("compiles under keepNames without a __name helper the page does not have", () => {
    // tsx compiles with keepNames; a named inner function became
    // `__name(...)` and page.evaluate threw ReferenceError on every take.
    const src = read("scripts/capture_demo.ts");
    const start = src.indexOf("export function installPhaseLatch(");
    const end = src.indexOf("\n}\n", start) + 3;
    expect(start).toBeGreaterThan(-1);
    const out = transformSync(src.slice(start, end), { loader: "ts", keepNames: true }).code;
    const body = out.slice(out.indexOf("{"), out.lastIndexOf("}"));
    expect(body).not.toContain("__name(");
  });
});

describe("where the script installs it", () => {
  const src = read("scripts/capture_demo.ts");
  const step = src.slice(src.indexOf('case "/tool-use": {'), src.indexOf('case "/partial-json": {'));

  it("before Run is clicked, then waits on the latch", () => {
    const install = step.indexOf("page.evaluate(installPhaseLatch, TOOL_CALL_PHASES)");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(step.indexOf("startRun("));
    expect(step).toContain("__capturePhaseLatched === true");
    expect(step.indexOf("__capturePhaseLatched === true")).toBeLessThan(step.indexOf('"interrupt-button"'));
  });

  it("no longer waits for the transient tool-phase text with locator.waitFor", () => {
    expect(step).not.toMatch(/TOOL_CALL_PHASES\.join[\s\S]*?\.waitFor\(/);
  });
});
