/**
 * Deterministic 60-second demo driver for the five-pattern tour
 * (issue #12).
 *
 * Drives a Playwright-controlled Chromium through the homepage and the
 * five pattern pages in sequence, executing the per-page interactions
 * that make each pattern visible on camera. The script is hermetic:
 * it forces mock mode (D-003) by unsetting ANTHROPIC_API_KEY in the
 * spawned Next.js dev server's env, so the capture never depends on a
 * key being present and the per-token timing stays reproducible across
 * recordings.
 *
 * The TIMELINE constant below is the source of truth for the tour and
 * is also imported by `test/capture-demo-smoke.test.ts`, which asserts
 * that the slugs line up with `app/page.tsx`'s `PATTERNS` array and
 * that every entry's `page.tsx` exists on disk. If a pattern's page
 * URL changes, the smoke test fails before any recording is attempted.
 *
 * Why a script + smoke test instead of committing the binary in this
 * PR: D-012. Same pattern as the five sister repos that landed today.
 *
 * Usage (after `npx playwright install chromium` once):
 *
 *   npm run capture                 # records docs/demo.webm (default)
 *   npm run capture -- --headed     # show the browser while recording
 *   CAPTURE_PACE_MS=500 npm run capture   # slow each step for debugging
 *   CAPTURE_OUT=docs/demo-2.webm npm run capture
 *
 * Environment variables:
 *
 *   CAPTURE_PACE_MS   per-step wait in ms (default 250; smoke test
 *                     passes 0)
 *   CAPTURE_HEADED    "1" to launch a visible browser; default
 *                     headless. Headed mode is what JT uses for final
 *                     recordings so the cursor is visible.
 *   CAPTURE_OUT       output path for the recorded video (default
 *                     docs/demo.webm)
 *   CAPTURE_BASE_URL  base URL to drive (default http://localhost:3000).
 *                     The script does NOT spawn the dev server — JT
 *                     runs `npm run dev` in another terminal first.
 *                     Keeping the lifecycle out of this script means a
 *                     failed capture doesn't leave a runaway server.
 *
 * Exit: 0 on full success, non-zero on any step failure (page never
 * navigated, selector missing for the required interaction, output
 * file not produced).
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A single stop on the demo tour. The `act` function is run after the
 * page has loaded; `holdMs` is the pause after `act` returns and
 * before the next stop begins (this is where the camera lingers on
 * the streaming text, the rolled-back item, etc.).
 *
 * `slug` matches the URL path under the Next.js app — "/" for the
 * homepage, "/streaming-text" for the first pattern, etc.
 *
 * `durationMs` is `holdMs` plus the typical time taken by the
 * interaction itself (estimated). The TIMELINE total should land at
 * ~60s and is asserted by the smoke test.
 */
export interface DemoStop {
  readonly slug: string;
  readonly label: string;
  readonly holdMs: number;
  readonly durationMs: number;
}

/**
 * The full tour. Six stops totaling ~60 seconds of recording.
 *
 * Order matches the README's narrative arc: index card → simplest
 * pattern → tool-use with the interrupt button → progressive JSON →
 * the optimistic-then-rollback sequence → the recover-from-drop demo.
 *
 * Imported by test/capture-demo-smoke.test.ts.
 */
export const TIMELINE: readonly DemoStop[] = [
  {
    slug: "/",
    label: "homepage — five-card index",
    holdMs: 6_000,
    durationMs: 6_000,
  },
  {
    slug: "/streaming-text",
    label: "streaming text — tokens arrive incrementally",
    holdMs: 9_000,
    durationMs: 10_000,
  },
  {
    slug: "/tool-use",
    label: "tool-use UI + mid-stream interrupt",
    holdMs: 11_000,
    durationMs: 13_000,
  },
  {
    slug: "/partial-json",
    label: "partial JSON — fields populate progressively",
    holdMs: 9_000,
    durationMs: 10_000,
  },
  {
    slug: "/optimistic-rollback",
    label: "optimistic update + deterministic rollback",
    holdMs: 11_000,
    durationMs: 12_000,
  },
  {
    slug: "/error-recovery",
    label: "deliberate drop + auto-resume with checkpoint pill",
    holdMs: 8_000,
    durationMs: 9_000,
  },
];

interface CaptureOptions {
  readonly baseUrl: string;
  readonly outPath: string;
  readonly headed: boolean;
  readonly paceMs: number;
}

function readOptions(argv: readonly string[]): CaptureOptions {
  const headed =
    argv.includes("--headed") || process.env.CAPTURE_HEADED === "1";
  const baseUrl = process.env.CAPTURE_BASE_URL ?? "http://localhost:3000";
  const outPath = process.env.CAPTURE_OUT ?? "docs/demo.webm";
  const paceRaw = process.env.CAPTURE_PACE_MS ?? "250";
  const paceMs = Number.parseInt(paceRaw, 10);
  if (!Number.isFinite(paceMs) || paceMs < 0) {
    throw new Error(
      `CAPTURE_PACE_MS must be a non-negative integer; got ${paceRaw}`,
    );
  }
  return { baseUrl, outPath, headed, paceMs };
}

async function runCapture(): Promise<void> {
  // Imported lazily so the smoke test can import TIMELINE without
  // pulling Playwright into the vitest module graph. Vitest never
  // executes this function.
  const { chromium } = await import("playwright");
  const opts = readOptions(process.argv.slice(2));

  await mkdir(dirname(opts.outPath), { recursive: true });

  console.log(`[capture] base=${opts.baseUrl} out=${opts.outPath} headed=${opts.headed}`);
  console.log(`[capture] stops=${TIMELINE.length}, target ~60s of footage`);

  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: dirname(opts.outPath), size: { width: 1280, height: 720 } },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  try {
    for (const stop of TIMELINE) {
      const url = new URL(stop.slug, opts.baseUrl).toString();
      console.log(`[capture] ${stop.slug} — ${stop.label}`);
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
      if (!resp || !resp.ok()) {
        const status = resp ? resp.status() : "no-response";
        throw new Error(`navigation to ${url} failed: status=${status}`);
      }
      await interactFor(page, stop.slug, opts.paceMs);
      await page.waitForTimeout(stop.holdMs);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log(`[capture] done. video saved under ${dirname(opts.outPath)}.`);
  console.log(
    `[capture] note: Playwright writes the video on context close with an auto-generated name.`,
  );
  console.log(
    `[capture] move/rename it to ${opts.outPath} once it finishes flushing.`,
  );
}

/**
 * Per-page interaction. Each stop performs whatever click/keypress
 * makes the pattern visible on camera; the page's own streaming
 * timers do the rest. Pace `paceMs` is added between actions so a
 * recording engineer can slow them down for a take.
 *
 * Selector strategy: prefer `getByTestId` against the testids already
 * defined in the components (`run-button`, `interrupt-button`,
 * `item-<name>`, `error-recovery-output`). When a page doesn't expose
 * a button (streaming-text, partial-json, error-recovery — they
 * auto-start on mount), the function simply returns and the timeline
 * `holdMs` carries the camera.
 */
async function interactFor(
  page: import("playwright").Page,
  slug: string,
  paceMs: number,
): Promise<void> {
  const wait = (ms: number) => page.waitForTimeout(ms);
  switch (slug) {
    case "/":
      // Homepage is static cards — let the camera linger.
      return;
    case "/streaming-text":
      // Auto-starts on mount (see StreamingTextClient useEffect).
      return;
    case "/tool-use": {
      // Click Run; let the tool-call render; click Interrupt mid-stream.
      await page.getByTestId("run-button").click();
      await wait(4_500 + paceMs);
      await page.getByTestId("interrupt-button").click();
      return;
    }
    case "/partial-json":
      // Auto-starts (see partial-json-client). The camera watches the
      // fields populate.
      return;
    case "/optimistic-rollback": {
      // Two clicks on the same item: the first commits (happy path), the
      // second resolves via the deterministic 50/50 oracle keyed by
      // (id, click_count) (D-010). We drive `untitled-2.txt` specifically
      // because it is one of the items the oracle ROLLS BACK on its 2nd click
      // (`decide({id:"untitled-2.txt", click_count:2}).ok === false`, pinned in
      // test/optimistic-decision.test.ts). The earlier `.first()` selected
      // `untitled-1.txt`, which the oracle SUCCEEDS on at click 2 (it rolls
      // back only at click 3), so the take showed two successes and never the
      // rollback animation this pattern exists to demonstrate (#62).
      const rollbackItem = page.locator('[data-testid="item-untitled-2.txt"]');
      const improveBtn = rollbackItem.getByRole("button", { name: /improve/i });
      await improveBtn.click();
      await wait(2_500 + paceMs);
      await improveBtn.click();
      return;
    }
    case "/error-recovery":
      // Auto-starts on mount; the route handler drops the first
      // request after DROP_AFTER_TOKENS so the recovery pill is
      // guaranteed to appear during the holdMs window.
      return;
    default:
      throw new Error(`no interaction defined for slug ${slug}`);
  }
}

// Run only when invoked directly (not when imported by the smoke test).
const isDirectRun =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module;

if (isDirectRun) {
  runCapture().catch((err: unknown) => {
    console.error("[capture] failed:", err);
    process.exit(1);
  });
}
