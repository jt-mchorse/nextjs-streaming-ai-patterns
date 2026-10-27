/**
 * `lib/checkpoint-stream.ts` folds whitespace into the FOLLOWING text event,
 * and its docstrings say so (#173).
 *
 * The file is one of the three the `/error-recovery` page shows verbatim in its
 * Source pane (D-004), so its docstrings are reader-facing teaching text. Two
 * of them described the whitespace handling backwards:
 *
 *   tokenize():          "reassembling tokens with `tokens.join(" ")` yields
 *                        the original prose" -- the capturing split keeps each
 *                        whitespace run as its own token, so `join(" ")` adds
 *                        a space at every boundary; only `join("")` reassembles.
 *   streamCheckpoints(): "Whitespace tokens are folded into the preceding text
 *                        event" -- the loop emits `pendingPrefix + tok`, so they
 *                        fold into the following one: ["A", " mid-stream", ...].
 *
 * The docstring arm reads the direction off the generator's real output rather
 * than hard-coding it, so the lock follows the code and not a transcription.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CheckpointStreamDropped,
  TOTAL_TOKENS,
  streamCheckpoints,
  type StreamOptions,
} from "../lib/checkpoint-stream";

// Zero delay. Since #230 the streamer paces each text event like the sibling
// mock streamers (30 ms + up to 30 ms jitter), so a test that wants the event
// sequence rather than the timing passes this, as #206's `FAST` does.
const FAST = { baseDelayMs: 0, jitterMs: 0 } as const;

const SOURCE = readFileSync(resolve(__dirname, "../lib/checkpoint-stream.ts"), "utf8");

/** The fixture the generator streams, read from the source it lives in. */
const FIXTURE = (() => {
  const m = /const FIXTURE = `([^`]*)`;/.exec(SOURCE);
  if (!m) throw new Error("FIXTURE literal not found in lib/checkpoint-stream.ts");
  return m[1] as string;
})();

/** The JSDoc block directly above `signature`, whitespace-collapsed, `*` gutters removed. */
function docAbove(signature: string): string {
  const at = SOURCE.indexOf(signature);
  if (at === -1) throw new Error(`${signature} not found`);
  const end = SOURCE.lastIndexOf("*/", at);
  const start = SOURCE.lastIndexOf("/**", end);
  // Nothing but whitespace may sit between the block and the signature.
  expect(SOURCE.slice(end + 2, at).trim()).toBe("");
  return SOURCE.slice(start + 3, end)
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** Text events of one run; a simulated drop ends the run instead of throwing. */
async function texts(options: StreamOptions = {}): Promise<{ texts: string[]; droppedAt: number | null }> {
  const out: string[] = [];
  try {
    for await (const e of streamCheckpoints({ ...FAST, ...options })) if (e.kind === "text") out.push(e.text);
  } catch (err) {
    if (!(err instanceof CheckpointStreamDropped)) throw err;
    return { texts: out, droppedAt: err.emitted };
  }
  return { texts: out, droppedAt: null };
}

describe("checkpoint-stream whitespace folding (#173)", () => {
  it("a clean run reassembles the fixture exactly with join(\"\")", async () => {
    const { texts: t } = await texts();
    expect(t.join("")).toBe(FIXTURE);
    // The control: the separator the old docstring named does not.
    expect(t.join(" ")).not.toBe(FIXTURE);
  });

  it("whitespace folds into the FOLLOWING event: none ends with it, every event after the first starts with it", async () => {
    const { texts: t } = await texts();
    expect(t.filter((s) => /\s$/.test(s))).toEqual([]);
    expect(t.slice(1).filter((s) => !/^\s/.test(s))).toEqual([]);
    expect(t[0]).toBe("A");
  });

  it("every drop point resumes with the seam whitespace on the first resumed event, and nothing is lost or doubled", async () => {
    const bad: number[] = [];
    for (let drop = 1; drop < TOTAL_TOKENS; drop++) {
      const first = await texts({ dropAfter: drop });
      if (first.droppedAt === null) throw new Error(`dropAfter ${drop} did not drop`);
      const resumed = await texts({ startAfter: first.droppedAt });
      const seamOk = /^\s/.test(resumed.texts[0] ?? "");
      if (!seamOk || first.texts.join("") + resumed.texts.join("") !== FIXTURE) bad.push(drop);
    }
    expect(bad).toEqual([]);
  });

  it("the served docstrings name the direction and the separator the generator actually uses", async () => {
    const { texts: t } = await texts();
    const direction = t.slice(1).every((s) => /^\s/.test(s)) ? "following" : "preceding";

    const streamDoc = docAbove("export async function* streamCheckpoints(");
    expect(streamDoc).toMatch(new RegExp(`folded into the ${direction} text event`, "i"));

    const tokenizeDoc = docAbove("function tokenize(");
    expect(tokenizeDoc).toContain('`tokens.join("")` reassembles the original prose');
  });
});
