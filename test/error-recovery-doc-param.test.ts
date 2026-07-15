// Lock test: the documented error-recovery SSE query param must match the
// param the route actually reads (#85).
//
// README.md and docs/architecture.md described the reconnect as `?since=N`,
// but the route reads `?checkpoint=N` (`url.searchParams.get("checkpoint")`)
// and the client sends `?checkpoint=`. A reader following the docs would build
// a client with the wrong param and silently never resume. No existing lock
// test pinned these prose strings, so the drift went unguarded. This ties the
// docs to the route's real `searchParams.get(...)` key so it can't drift again.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const ROUTE_PATH = resolve(ROOT, "app/api/error-recovery/route.ts");
const README_PATH = resolve(ROOT, "README.md");
const ARCH_PATH = resolve(ROOT, "docs/architecture.md");

describe("error-recovery SSE query param docs match the route (#85)", () => {
  const route = readFileSync(ROUTE_PATH, "utf8");
  const readme = readFileSync(README_PATH, "utf8");
  const arch = readFileSync(ARCH_PATH, "utf8");

  // Ground truth: every `url.searchParams.get("<key>")` the route reads.
  const readParams = [...route.matchAll(/searchParams\.get\(\s*["']([^"']+)["']\s*\)/g)].map(
    (m) => m[1],
  );

  it("the route reads exactly the `checkpoint` query param (ground truth)", () => {
    // Guards the extraction: if the route is refactored to read a different or
    // additional param, this fails loud so the doc assertions below stay honest.
    expect(readParams).toEqual(["checkpoint"]);
  });

  it("README and architecture.md reference the real `?checkpoint=` param", () => {
    for (const [name, md] of [
      ["README.md", readme],
      ["docs/architecture.md", arch],
    ] as const) {
      expect(md.includes("?checkpoint="), `${name} should document ?checkpoint=`).toBe(true);
    }
  });

  it("no doc names the stale `?since=` param or the unimplemented `session=` param", () => {
    // `?since=N` was the pre-#85 drift; `session=S` was a phantom param in the
    // route docstring that the route never reads (only `checkpoint`).
    expect(readParams).not.toContain("session");
    for (const [name, text] of [
      ["README.md", readme],
      ["docs/architecture.md", arch],
      ["route.ts", route],
    ] as const) {
      expect(text.includes("?since="), `${name} must not name the stale ?since= param`).toBe(
        false,
      );
      expect(
        /[?&]session=/.test(text),
        `${name} must not document the unimplemented session= param`,
      ).toBe(false);
    }
  });
});
