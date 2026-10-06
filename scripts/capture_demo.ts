/**
 * Deterministic 60-second demo driver for the five-pattern tour
 * (issue #12).
 *
 * Drives a Playwright-controlled Chromium through the homepage and the
 * five pattern pages in sequence, executing the per-page interactions
 * that make each pattern visible on camera. It records mock mode (D-003)
 * only. The mode is chosen by the dev server's own environment, and this
 * script does not start the server, so before launching a browser it reads
 * the `/streaming-text` mode pill and refuses anything but mock. This header
 * used to say the script "forces mock mode by unsetting ANTHROPIC_API_KEY in
 * the spawned dev server's env". It spawns nothing, so a key exported in the
 * shell that ran `npm run dev` made the tour a live, billed,
 * non-reproducible recording (#146).
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
 *   CAPTURE_PACE_MS   per-step wait in ms (default 250). Must be a
 *                     non-negative integer written in plain decimal --
 *                     `1e3` and `1_000` are rejected, not silently read
 *                     as 1 (#104). Empty/whitespace-only is treated as
 *                     unset.
 *   CAPTURE_HEADED    "1" to launch a visible browser; default
 *                     headless. Headed mode is what JT uses for final
 *                     recordings so the cursor is visible.
 *   CAPTURE_OUT       output path for the recorded video (default
 *                     docs/demo.webm)
 *   CAPTURE_BASE_URL  base URL to drive (default http://localhost:3000).
 *                     Must be absolute; validated in `readOptions`, before
 *                     a browser is launched. Empty/whitespace-only is
 *                     treated as unset.
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

export interface CaptureOptions {
  readonly baseUrl: string;
  readonly outPath: string;
  readonly headed: boolean;
  readonly paceMs: number;
}

export const DEFAULT_BASE_URL = "http://localhost:3000";
export const DEFAULT_OUT_PATH = "docs/demo.webm";
export const DEFAULT_PACE_MS = 250;

/**
 * Read an environment variable, treating a set-but-*empty* value as unset.
 *
 * `??` defaults on `null`/`undefined` only, so `CAPTURE_BASE_URL= npm run
 * capture` — and an empty line in a `.env` file — reached `new URL()` with an
 * empty string and threw a bare `TypeError: Invalid URL` (#104).
 *
 * `lib/anthropic-stream.ts` already does exactly this for `ANTHROPIC_MODEL`,
 * and its reason transfers verbatim: "The pre-#32 shape passed an empty string
 * verbatim to the SDK, which surfaced as an API error rather than failing loud
 * against the local fallback." #32 was scoped to `lib/`; `scripts/` was never
 * swept.
 */
function envOrDefault(name: string, fallback: string): string {
  const raw = (process.env[name] ?? "").trim();
  return raw.length > 0 ? raw : fallback;
}

/**
 * A non-negative integer, or `null` if `raw` is not one.
 *
 * Deliberately not `Number.parseInt`. The guard's message has always said
 * "must be a non-negative integer", and `parseInt` enforces no such thing --
 * it consumes a numeric *prefix* and discards the rest. Measured (#104):
 *
 *     "250"      -> 250      "1e3"    -> 1        <- 1000x low
 *     "250abc"   -> 250      "1_000"  -> 1        <- 1000x low
 *     "+250"     -> 250      "12,000" -> 12       <- 1000x low
 *     "  250  "  -> 250      "0x10"   -> 0
 *                            "3.9"    -> 3
 *
 * `1e3` and `1_000` are the two natural ways to write "one thousand
 * milliseconds", and both silently became **1 ms** -- in the one knob whose
 * entire job is to slow each interaction down enough to be visible on camera.
 * The capture races through every stop and produces unusable footage, with
 * nothing in the log to say the value was misread.
 *
 * `3.9 -> 3` is rejected rather than truncated for the same reason: silently
 * accepting a value the stated contract excludes is what this is fixing.
 *
 * `Number.isFinite` alone would not have caught any of the above, and could
 * only ever have caught `NaN` -- `parseInt` cannot return `Infinity` -- so the
 * old check read as broader than it was.
 */
function parseNonNegativeInt(raw: string): number | null {
  if (!/^\+?\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function readOptions(argv: readonly string[]): CaptureOptions {
  const headed =
    argv.includes("--headed") || process.env.CAPTURE_HEADED === "1";
  const baseUrl = envOrDefault("CAPTURE_BASE_URL", DEFAULT_BASE_URL);
  const outPath = envOrDefault("CAPTURE_OUT", DEFAULT_OUT_PATH);

  const paceRaw = envOrDefault("CAPTURE_PACE_MS", String(DEFAULT_PACE_MS));
  const paceMs = parseNonNegativeInt(paceRaw);
  if (paceMs === null) {
    throw new Error(
      `CAPTURE_PACE_MS must be a non-negative integer in milliseconds; got ` +
        `${JSON.stringify(paceRaw)}. Exponent and separator forms are not ` +
        `accepted -- write 1000, not 1e3 or 1_000.`,
    );
  }

  // Validated HERE rather than where it is used. `new URL(stop.slug,
  // opts.baseUrl)` first runs inside `runCapture`'s loop -- after
  // `chromium.launch()` and `context.newPage()` -- so an unusable base URL
  // threw a bare `TypeError: Invalid URL` with a browser already live and a
  // video recording context already open, and with nothing in the message
  // naming the variable at fault. The pace guard above already demonstrates
  // the right shape: fail in `readOptions`, before any of that (#104).
  //
  // Classified by attempting the parse rather than pattern-matched: the set of
  // things `new URL` accepts as a base is exactly what matters here, and
  // reimplementing it would carry false-positive risk on working setups where
  // asking it carries none.
  try {
    new URL("/", baseUrl);
  } catch {
    const hint = /^[\w.-]+(:\d+)?(\/|$)/.test(baseUrl)
      ? " (it looks like a scheme is missing -- try http://" + baseUrl + ")"
      : "";
    throw new Error(
      `CAPTURE_BASE_URL must be an absolute URL; got ${JSON.stringify(baseUrl)}${hint}`,
    );
  }

  return { baseUrl, outPath, headed, paceMs };
}

/**
 * Refuse unless the dev server streams from the mock (#146). `mode` is the
 * `data-stream-mode` attribute of the `/streaming-text` mode pill, which the
 * page sets from `getStreamMode()` -- the same function that picks the
 * streamer. The attribute, not the page's text: that page's Source pane
 * renders `lib/anthropic-stream.ts`, whose comments say "mock streamer"
 * whatever mode the server is in. A missing attribute (null) is refused too:
 * a capture that cannot tell the mode is not known to be mock.
 */
/**
 * The `data-stream-mode` value in a server-rendered `/streaming-text`, or
 * null unless there is exactly one, so a page that lost or duplicated the
 * pill is refused rather than guessed at.
 */
export function modeFromHtml(html: string): string | null {
  const found = [...html.matchAll(/\bdata-stream-mode="([^"]*)"/g)];
  return found.length === 1 ? found[0][1] : null;
}

export function assertMockMode(mode: string | null, baseUrl: string): void {
  if (mode === "mock") return;
  const seen = mode === null ? "in a mode this script cannot read" : `in ${JSON.stringify(mode)} mode`;
  throw new Error(
    `the dev server at ${baseUrl} is ${seen}, not mock: the capture records ` +
      "mock mode only (D-003), and the server's own environment decides it. " +
      "Restart it without a key, e.g. `env -u ANTHROPIC_API_KEY npm run dev`.",
  );
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

  // Mock mode or nothing (#146): the server's env decides, so ask it before
  // a browser is launched -- a check through the recording page would put
  // an extra page at the start of the video.
  const pillUrl = new URL("/streaming-text", opts.baseUrl).toString();
  const resp = await fetch(pillUrl);
  if (!resp.ok) throw new Error(`mode check: ${pillUrl} answered ${resp.status}`);
  assertMockMode(modeFromHtml(await resp.text()), opts.baseUrl);

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
 * A run has started once the page's own `phase:` readout leaves `idle`.
 *
 * The page's state, not a timer, because both ways this script used to fail
 * were timing guesses (#144): a click on the server-rendered button before
 * React attached its handler did nothing, and an Interrupt scheduled 4.5 s
 * after Run landed after the ~2.2 s mock stream had already finished.
 */
export function hasStarted(phaseText: string | null): boolean {
  const phase = (phaseText ?? "").trim();
  return phase !== "" && phase !== "idle";
}

/** The `/tool-use` phases in which a tool call is on screen and the stream is still live. */
export const TOOL_CALL_PHASES: ReadonlyArray<string> = ["tool_called", "tool_running", "tool_completed"];

/**
 * Click `button` until the page reports a started run. A click that lands
 * before hydration is a no-op on the server-rendered markup, so retry a bounded
 * number of times rather than trust the first one.
 */
async function startRun(
  page: import("playwright").Page,
  button: import("playwright").Locator,
  phase: import("playwright").Locator,
  attempts = 6,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await button.click({ timeout: 5_000 });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (hasStarted(await phase.textContent())) return;
      await page.waitForTimeout(100);
    }
  }
  throw new Error(`run did not start after ${attempts} clicks (phase stayed idle)`);
}

/**
 * Per-page interaction. Each stop performs whatever click/keypress
 * makes the pattern visible on camera; the page's own streaming
 * timers do the rest. Pace `paceMs` is added between actions so a
 * recording engineer can slow them down for a take.
 *
 * Selector strategy: prefer `getByTestId` against the testids already
 * defined in the components (`run-button`, `interrupt-button`,
 * `item-<name>`, `error-recovery-output`). streaming-text and
 * error-recovery auto-start on mount, so the function returns and the
 * timeline `holdMs` carries the camera. partial-json does NOT -- its only
 * effect is the unmount teardown -- so it is started from its button (#144).
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
      // Click Run; let the tool call render; click Interrupt mid-stream.
      // On the page's phase, not a timer (#144): the mock stream is ~2.2 s end
      // to end with the tool call at ~0.8 s, so the old fixed 4.5 s wait always
      // found Interrupt disabled. No pace between the tool call and Interrupt
      // for the same reason -- the window is about a second.
      const phase = page.getByTestId("phase").locator("code");
      await wait(paceMs);
      await startRun(page, page.getByTestId("run-button"), phase);
      await phase.filter({ hasText: new RegExp(`^(${TOOL_CALL_PHASES.join("|")})$`) }).waitFor({ timeout: 10_000 });
      await page.getByTestId("interrupt-button").click({ timeout: 5_000 });
      await phase.filter({ hasText: /^interrupted$/ }).waitFor({ timeout: 5_000 });
      return;
    }
    case "/partial-json": {
      // Started from "Plan a trip": partial-json-client has no start-on-mount
      // effect, so the old "auto-starts" comment filmed an idle page (#144).
      // The camera then watches the fields populate.
      await wait(paceMs);
      await startRun(
        page,
        page.getByRole("button", { name: "Plan a trip" }),
        page.locator("span", { hasText: "phase:" }).locator("code").first(),
      );
      return;
    }
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
