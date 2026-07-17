// Lock test: the README's SSE transport-contract paragraph must match the
// envelope the routes actually emit and the mechanism D-006 decided (#89).
//
// The README claimed "every route handler emits the same `data: {kind, ...}`
// envelope, every client tags events by `kind`". But only error-recovery puts
// `kind` in its data; tool-use and partial-json tag variants by the SSE
// `event:` field (event types), which is exactly what D-006 records
// ("client_renderer_unions_over_event_types_dispatches_in_one_place"). So the
// code matched D-006 and the README was the drift. This ties the README's
// prose to the routes' real wire format so it can't drift again — the
// transport-envelope sibling of the #85/#87 error-recovery doc-drift locks.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const README = readFileSync(resolve(ROOT, "README.md"), "utf8");
const route = (name: string) =>
  readFileSync(resolve(ROOT, `app/api/${name}/route.ts`), "utf8");

const streamText = route("stream-text");
const toolUse = route("tool-use");
const partialJson = route("partial-json");
const errorRecovery = route("error-recovery");

describe("README SSE envelope contract matches the routes + D-006 (#89)", () => {
  it("stream-text streams a bare `data: {text}` frame — no `kind` (ground truth)", () => {
    // The per-token payload is JSON.stringify({ text: ... }); the route never
    // emits a `kind` discriminator. If this changes the README claim must too.
    expect(/JSON\.stringify\(\{\s*text:/.test(streamText)).toBe(true);
    expect(streamText.includes("kind")).toBe(false);
  });

  it("tool-use and partial-json tag variants by the SSE `event:` field (D-006)", () => {
    // Both emit `event: ${...}\ndata: ${data}` — the event *type* is the tag,
    // not a `kind` inside data. This is the mechanism the README must describe.
    expect(/event: \$\{event\.type\}\\ndata:/.test(toolUse)).toBe(true);
    expect(/event: \$\{type\}\\ndata:/.test(partialJson)).toBe(true);
  });

  it("error-recovery is the only route carrying a `kind` discriminator in data", () => {
    // The checkpoint pattern sends default `data:` frames distinguished by an
    // in-data `kind` ("text" | "checkpoint"), so the README notes `kind` as
    // this pattern's discriminator — not a universal envelope field.
    expect(errorRecovery.includes("kind")).toBe(true);
    for (const [name, src] of [
      ["tool-use", toolUse],
      ["partial-json", partialJson],
    ] as const) {
      expect(src.includes("kind"), `${name} must not emit a kind field`).toBe(false);
    }
  });

  it("README describes event-type dispatch and drops the stale `kind` envelope claim", () => {
    // Positive: the real, D-006 mechanism.
    expect(README.includes("tagged by the SSE `event:` field")).toBe(true);
    expect(README.includes("unions over the")).toBe(true);
    // Negative: the pre-#89 drift — a single `data: {kind, ...}` envelope that
    // every client tags by `kind`.
    expect(README.includes("tags events by `kind`")).toBe(false);
    expect(README.includes("`data: {kind, ...}` envelope")).toBe(false);
  });
});
