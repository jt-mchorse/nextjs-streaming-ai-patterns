/**
 * Streaming-client cleanup-parity lock (issue #78).
 *
 * Every client component that owns an `AbortController` MUST drive it on
 * unmount — otherwise navigating away mid-stream leaks the underlying
 * `fetch`/`ReadableStream` reader until the server finishes on its own,
 * defeating the abort-on-disconnect contract the SSE routes are built
 * around (D-007). A browser `fetch` is NOT auto-aborted when its
 * initiating React component unmounts, so the teardown must be explicit.
 *
 * This is a source-level lock in the idiom of `test/public-surface.test.ts`
 * and `test/readme-patterns-table.test.ts` — this repo pushes logic into
 * `lib/` and has no component-render harness (no jsdom / testing-library),
 * so we assert the invariant against the committed source instead.
 *
 * Discovery rule: any `components/*.tsx` containing `new AbortController(`
 * is a streaming client and is auto-covered. A fifth client that forgets
 * the teardown fails this test rather than shipping the same leak
 * `partial-json-client` and `error-recovery-client` originally had.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const COMPONENTS_DIR = resolve(ROOT, "components");

// A `useEffect` unmount cleanup that aborts a controller:
//   return () => controllerRef.current?.abort();
//   return () => { cancelled = true; controller.abort(); };
//   return () => { aborted.current = true; controllerRef.current?.abort(); };
// Comments are stripped before matching so an explanatory comment inside the
// cleanup body can't push `.abort()` outside the proximity window.
const UNMOUNT_ABORT = /return\s*\(\s*\)\s*=>[\s\S]{0,160}?\.abort\s*\(/;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, ""); // line comments
}

function listStreamingClients(): string[] {
  return readdirSync(COMPONENTS_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .filter((f) =>
      readFileSync(resolve(COMPONENTS_DIR, f), "utf-8").includes(
        "new AbortController(",
      ),
    )
    .sort();
}

describe("streaming-client cleanup parity (#78)", () => {
  const clients = listStreamingClients();

  it("finds the streaming client components (sanity)", () => {
    // The four documented streaming patterns each own a controller. If this
    // drops below four, either a client was removed or the discovery rule
    // (`new AbortController(`) stopped matching — both worth a human look.
    expect(
      clients,
      `expected the AbortController-owning clients under components/, got ${JSON.stringify(clients)}`,
    ).toEqual(
      expect.arrayContaining([
        "error-recovery-client.tsx",
        "partial-json-client.tsx",
        "streaming-text-client.tsx",
        "tool-use-client.tsx",
      ]),
    );
    expect(clients.length).toBeGreaterThanOrEqual(4);
  });

  it.each(listStreamingClients())(
    "%s imports useEffect (required for an unmount cleanup)",
    (filename) => {
      const src = readFileSync(resolve(COMPONENTS_DIR, filename), "utf-8");
      expect(
        /import\s*\{[^}]*\buseEffect\b[^}]*\}\s*from\s*["']react["']/.test(src),
        `${filename} owns an AbortController but does not import useEffect, ` +
          "so it cannot register an unmount cleanup. Import useEffect and " +
          "abort the controller on teardown (see tool-use-client.tsx).",
      ).toBe(true);
    },
  );

  it.each(listStreamingClients())(
    "%s aborts its AbortController on unmount",
    (filename) => {
      const src = stripComments(
        readFileSync(resolve(COMPONENTS_DIR, filename), "utf-8"),
      );
      expect(
        UNMOUNT_ABORT.test(src),
        `${filename} owns an AbortController but has no unmount cleanup that ` +
          "calls .abort(). Navigating away mid-stream would leak the fetch/" +
          "reader until server EOF and never trip the route's abort-on-" +
          "disconnect path (D-007). Add `return () => controllerRef.current?.abort()` " +
          "to a useEffect (see tool-use-client.tsx / streaming-text-client.tsx).",
      ).toBe(true);
    },
  );
});
