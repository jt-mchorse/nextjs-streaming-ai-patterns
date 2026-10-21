/**
 * A run that has ended stops showing in-progress affordances (#205).
 *
 * After Interrupt (or an error) `/partial-json` kept every unfilled field as a
 * pulsing skeleton under copy promising the fields "will replace their
 * skeletons as the stream completes them", and `/tool-use` kept the streaming
 * caret `▍` on a tool card whose args never completed. `Itinerary` was never
 * given the phase, and `ToolCard` drew the caret on `!args_complete` alone.
 * The other two streaming clients already clear their cursor once the run is
 * terminal; #142 was the reverse mismatch (a cut stream shown as finished).
 *
 * This repo has no component-render harness, so the clients' hooks are mocked:
 * `useState` hands back seeded state in declaration order, and the element the
 * client returns is rendered with React's real server renderer. The sub-
 * components under test (`Itinerary`, `Field`, `ToolCard`) use no hooks.
 */
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let seeded: unknown[] = [];
let slot = 0;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const mine = slot++;
      return [mine < seeded.length ? seeded[mine] : initial, () => {}];
    },
    useCallback: (fn: unknown) => fn,
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: () => {},
  };
});

import { PartialJsonClient } from "../components/partial-json-client";
import { ToolUseClient } from "../components/tool-use-client";

beforeAll(() => {
  // The test transform compiles JSX to a bare `React.createElement`.
  vi.stubGlobal("React", { createElement, Fragment });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

function render(client: () => React.ReactElement, state: unknown[]): string {
  seeded = state;
  slot = 0;
  return renderToStaticMarkup(client());
}

// PartialJsonClient slots: phase, parsed, isComplete, bufferLen, error.
const PARTIAL = { destination: "Austin, TX", trip_length_days: 3 };
const FULL = {
  destination: "Austin, TX",
  trip_length_days: 3,
  summary: "A long weekend.",
  daily_plan: [{ day: 1, morning: "a", afternoon: "b", evening: "c" }],
  budget_estimate_usd: 900,
};
const partialJson = (phase: string, parsed: unknown, isComplete: boolean, error: string | null = null) =>
  render(PartialJsonClient, [phase, parsed, isComplete, 55, error]);

const PULSE = /animate-pulse/g;
const WILL_REPLACE = "will replace their skeletons";
const NOT_RECEIVED = "not received";

describe("/partial-json after the run ends (#205)", () => {
  it.each([
    ["interrupted", null],
    ["error", "HTTP 500"],
  ] as const)("%s: unfilled fields are static, not pulsing skeletons", (phase, error) => {
    const html = partialJson(phase, PARTIAL, false, error);
    expect(html.match(PULSE)).toBeNull();
    expect(html).not.toContain(WILL_REPLACE);
    // Anti-vacuity: the fields that did arrive still render, and the ones that
    // did not are marked -- summary, budget, and 3 placeholder days x 3 fields.
    expect(html).toContain("Austin, TX");
    expect(html.split(`>${NOT_RECEIVED}<`).length - 1).toBe(11);
  });

  it("done with an incomplete parse is terminal too", () => {
    const html = partialJson("done", PARTIAL, false);
    expect(html.match(PULSE)).toBeNull();
    expect(html).not.toContain(WILL_REPLACE);
  });

  // Controls: green before and after the fix.
  it("streaming still pulses and keeps the will-replace copy", () => {
    const html = partialJson("streaming", PARTIAL, false);
    expect(html.match(PULSE)?.length).toBe(11);
    expect(html).toContain(WILL_REPLACE);
    expect(html).not.toContain(NOT_RECEIVED);
  });

  it("idle (nothing asked for yet) still shows skeletons", () => {
    const html = partialJson("idle", null, false);
    expect(html.match(PULSE)?.length).toBeGreaterThan(0);
    expect(html).not.toContain(NOT_RECEIVED);
  });

  it("a complete done run has no placeholder of either kind", () => {
    const html = partialJson("done", FULL, true);
    expect(html.match(PULSE)).toBeNull();
    expect(html).not.toContain(NOT_RECEIVED);
    expect(html).not.toContain(WILL_REPLACE);
  });
});

// ToolUseClient slots: phase, timeline, error.
const openTool = {
  kind: "tool_call",
  tool_use_id: "toolu_1",
  tool_name: "get_weather",
  partial_args: '{"city":"Austin","',
  parsed_args: null,
  result: null,
  args_complete: false,
};
const toolUse = (phase: string, node: object = openTool, error: string | null = null) =>
  render(ToolUseClient, [phase, [node], error]);

const CARET = "▍";

describe("/tool-use after the run ends (#205)", () => {
  it.each([
    ["interrupted", null],
    ["error", "HTTP 500"],
  ] as const)("%s: an unfinished tool card has no streaming caret", (phase, error) => {
    const html = toolUse(phase, openTool, error);
    expect(html).not.toContain(CARET);
    // Anti-vacuity: the card and the args that did arrive still render.
    expect(html).toContain('data-testid="tool-card-toolu_1"');
    expect(html).toContain("{&quot;city&quot;:&quot;Austin&quot;,&quot;</pre>");
  });

  // Controls: green before and after the fix.
  it.each(["tool_called", "streaming_text"])("%s still shows the caret", (phase) => {
    expect(toolUse(phase)).toContain(`&quot;${CARET}</pre>`);
  });

  it("a card whose args completed has no caret, whatever the phase", () => {
    const done = { ...openTool, args_complete: true, parsed_args: { city: "Austin" } };
    expect(toolUse("tool_running", done)).not.toContain(CARET);
  });
});
