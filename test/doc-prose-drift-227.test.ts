/**
 * The error-recovery prose says where the client resumes (#227).
 *
 * Since #58/#80 the client resumes from the furthest position it knows was
 * delivered: the drop's `last_token` when the error frame carries one, else
 * the last checkpoint or rendered token. Resuming from the checkpoint was
 * dropped on purpose, because it replays the tokens between the checkpoint and
 * the drop. Six sites still said the client "records the most-recent
 * checkpoint and reconnects with it": the homepage card, the page's docstring
 * and intro paragraph, the header of `lib/checkpoint-stream.ts` (which its own
 * `resumeTokenPosition` contradicted), the README and architecture bullets, and
 * the client's docstring. A browser run showed `?checkpoint=0` then
 * `?checkpoint=12` with `CHECKPOINT_EVERY = 5`, so 12 is not a checkpoint.
 *
 * Each site is checked for the old claim and for naming the drop position.
 * The controls pin the fact the prose has to match, so the lock cannot go
 * green by changing the code back instead.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/error-recovery/route";
import { resumeTokenPosition } from "@/lib/checkpoint-stream";

const ROOT = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/**
 * Prose as one line: leading comment-marker characters, JSX spacers and line
 * breaks folded away. This reads comment text on purpose, so it is not
 * `stripComments`, which removes it.
 */
function norm(text: string): string {
  return text
    .replace(/^[\s*/]+/gm, "")
    .replace(/\{" "\}/g, " ")
    .replace(/<\/?code>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** From the first `start` to the first `end` after it. */
function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i === -1) return "";
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j === -1 ? undefined : j);
}

const PAGE = read("app/error-recovery/page.tsx");
const CLIENT = read("components/error-recovery-client.tsx");

const SITES: ReadonlyArray<readonly [string, string]> = [
  ["app/page.tsx card", between(read("app/page.tsx"), 'slug: "/error-recovery"', "issue:")],
  ["app/error-recovery/page.tsx docstring", between(PAGE, "/**", "*/")],
  ["app/error-recovery/page.tsx intro", between(PAGE, "The protocol underneath", "</p>")],
  ["lib/checkpoint-stream.ts header", between(read("lib/checkpoint-stream.ts"), "Deterministic checkpoint-bearing", "export const")],
  ["README.md #5 bullet", between(read("README.md"), "**Error recovery mid-stream** (#5)", "\n\n")],
  ["docs/architecture.md #5 bullet", between(read("docs/architecture.md"), "**`app/error-recovery/`** (#5)", "\n\n")],
  [
    "error-recovery-client docstring",
    between(CLIENT, "Reads /api/error-recovery", "*/"),
  ],
].map(([name, text]) => [name, norm(text)] as const);

// The resume-from-checkpoint wording each site used before #227.
const OLD_CLAIM =
  /records? (it|the most[- ]recent( one| checkpoint)?)|reconnects with it|resume from the last (server-side )?checkpoint|as the most-recent resume point/i;

describe("error-recovery prose: resumes from the drop position, not the last checkpoint (#227)", () => {
  it.each(SITES)("%s is found and is about checkpoints (anti-vacuity)", (_name, text) => {
    expect(text.length).toBeGreaterThan(40);
    expect(text).toMatch(/checkpoint/i);
  });

  it.each(SITES)("%s does not say the client resumes from the recorded checkpoint", (_name, text) => {
    expect(text).not.toMatch(OLD_CLAIM);
  });

  it.each(SITES)("%s names the drop position as where the client resumes", (_name, text) => {
    expect(text).toMatch(/furthest (position|token)/i);
    expect(text).toMatch(/drop/i);
  });
});

describe("control: the client does resume past the last checkpoint", () => {
  it("the route's first request drops at token 12, two past checkpoint 10", async () => {
    const res = await GET(new Request("http://x/api/error-recovery?checkpoint=0") as never);
    const body = await res.text();
    const checkpoints = [...body.matchAll(/"kind":"checkpoint","last_token":(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    const error = body.split("\n\n").find((f) => f.includes("event: error")) ?? "";
    expect(checkpoints.at(-1)).toBe(10);
    expect(error).toContain('"last_token":12');
  });

  it("resumeTokenPosition picks the drop position over the checkpoint", () => {
    expect(resumeTokenPosition(10, 12)).toBe(12);
    // No drop position: the checkpoint is the fallback.
    expect(resumeTokenPosition(10)).toBe(10);
  });

  it("the client feeds the error frame's last_token to resumeTokenPosition", () => {
    expect(CLIENT).toMatch(/resumeTokenPosition\(\s*lastCheckpoint\.current,\s*typeof data\.last_token/);
    expect(CLIENT).toMatch(/Math\.max\(lastCheckpoint\.current,\s*lastRendered\.current\)/);
  });
});
