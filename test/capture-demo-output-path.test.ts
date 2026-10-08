/**
 * `npm run capture` writes its take to `CAPTURE_OUT` (#160).
 *
 * The script passed only `dirname(outPath)` to Playwright's `recordVideo.dir`.
 * Playwright named the file `page@<hash>.webm`, nothing wrote `outPath`, and
 * the run exited 0 with a "move/rename it" note. Measured on main with
 * `CAPTURE_OUT=/tmp/capout/demo-take.webm`: rc 0, and the directory held only
 * `page@e9dff90f….webm`.
 *
 * `saveVideo` is exercised with a fake `Video`, because Playwright's `saveAs` is
 * what produces the file and a real browser is not available in CI. The
 * end-to-end evidence (a real take landing at `CAPTURE_OUT`) is in the PR.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { saveVideo, type SavableVideo } from "../scripts/capture_demo";
import { stripComments } from "./support/source-files";

const ROOT = resolve(__dirname, "..");

function fakeVideo(write: (path: string) => void): SavableVideo & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async saveAs(path: string) {
      log.push(`saveAs ${path}`);
      write(path);
    },
    async delete() {
      log.push("delete");
    },
  };
}

describe("saveVideo writes the take to CAPTURE_OUT (#160)", () => {
  it("saves to the given path and then deletes the auto-named copy", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "capture-")), "demo.webm");
    const video = fakeVideo((p) => writeFileSync(p, "webm"));
    await saveVideo(video, out);
    expect(video.log).toEqual([`saveAs ${out}`, "delete"]);
    expect(readFileSync(out, "utf8")).toBe("webm");
  });

  it("throws when nothing ends up at the path, so the run exits non-zero", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "capture-")), "demo.webm");
    await expect(saveVideo(fakeVideo(() => {}), out)).rejects.toThrow(/not written .*missing/);
    expect(existsSync(out)).toBe(false);
  });

  it("throws when the file at the path is empty", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "capture-")), "demo.webm");
    await expect(saveVideo(fakeVideo((p) => writeFileSync(p, "")), out)).rejects.toThrow(/empty/);
  });

  it("throws when the page recorded no video", async () => {
    await expect(saveVideo(null, "/tmp/never.webm")).rejects.toThrow(/no video was recorded/);
  });
});

describe("runCapture uses saveVideo, after the context closes", () => {
  const src = stripComments(readFileSync(resolve(ROOT, "scripts/capture_demo.ts"), "utf8"));
  const body = src.slice(src.indexOf("async function runCapture"), src.indexOf("export function hasStarted"));

  it("finds runCapture (non-zero control)", () => {
    expect(body.length).toBeGreaterThan(200);
  });

  it("saves to opts.outPath after context.close()", () => {
    const close = body.indexOf("await context.close()");
    const save = body.indexOf("saveVideo(video, opts.outPath)");
    expect(close).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(close);
  });

  it("no longer asks for a manual rename", () => {
    expect(body).not.toMatch(/move\/rename/);
  });
});
