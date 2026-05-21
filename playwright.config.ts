import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * Minimal Playwright config used by `scripts/capture_demo.ts` (issue
 * #12). There are no Playwright *tests* in this repo — vitest covers
 * unit tests and snapshot tests; this config exists so that the
 * capture script's video recording shares one canonical viewport,
 * deviceScaleFactor, and project shape with anything we add later.
 *
 * If/when an actual Playwright spec suite lands (e.g. acceptance
 * tests for the five-pattern tour), point `testDir` at it and add a
 * `webServer` block. Today the capture script reads from this config
 * indirectly — the values below are the source of truth that the
 * script's `newContext({...})` mirrors.
 *
 * `outputDir` is also where the recorded video files land before being
 * moved to `docs/demo.webm`. Mirrors `dirname(CAPTURE_OUT)`.
 */
const config: PlaywrightTestConfig = {
  testDir: "./test/playwright",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "./docs",
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    video: "on",
    headless: true,
  },
};

export default config;
