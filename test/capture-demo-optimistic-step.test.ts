import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { decide } from "../lib/optimistic-decision";

/**
 * The /optimistic-rollback stop films a rollback, or the take fails (#150).
 *
 * Click 1 used to go in right after domcontentloaded. On a cold dev server it
 * landed before hydration and did nothing, so click 2 was the item's first,
 * the oracle committed it, and the take never showed a rollback (2 of 2 cold
 * tours) while still exiting 0. With click 1 retried until it registers and a
 * required "rolled back", two cold takes both showed the rollback. These arms
 * pin the step's shape and the oracle facts it relies on.
 */

const ROOT = resolve(__dirname, "..");
const src = readFileSync(resolve(ROOT, "scripts/capture_demo.ts"), "utf8");
const step = src.slice(src.indexOf('case "/optimistic-rollback": {'), src.indexOf('case "/error-recovery":'));
// Line comments dropped: the step's own comment quotes the old fixed wait.
const LINE_COMMENT = "/" + "/";
const code = step
  .split("\n")
  .filter((l) => !l.trim().startsWith(LINE_COMMENT))
  .join("\n");

describe("the optimistic step (#150)", () => {
  it("retries click 1 until the item's name has left untitled-2.txt", () => {
    expect(code).toMatch(/clickUntil\(\s*page,\s*improveBtn,[\s\S]*?!== "untitled-2\.txt"/);
    // Exactly one bare click: the second, sent after hydration has been proven.
    expect(code.match(/improveBtn\.click\(/g)).toHaveLength(1);
    expect(code.indexOf("clickUntil(")).toBeLessThan(code.indexOf("improveBtn.click("));
  });

  it("waits for click 1 to settle before click 2", () => {
    const settle = code.indexOf('hasNotText: "(improving"');
    expect(settle).toBeGreaterThan(code.indexOf("clickUntil("));
    expect(settle).toBeLessThan(code.indexOf("improveBtn.click("));
  });

  it("fails the take unless that item ends up showing 'rolled back'", () => {
    const rolled = code.indexOf("rollbackItem.getByText(/^rolled back · /).waitFor(");
    expect(rolled).toBeGreaterThan(code.indexOf("improveBtn.click("));
  });

  it("no fixed wait stands in for click 1's result any more", () => {
    expect(code).not.toMatch(/improveBtn\.click\(\);\s*await wait\(/);
  });
});

describe("the facts the step relies on", () => {
  it("the oracle commits untitled-2.txt's 1st click and rolls back its 2nd (#62)", () => {
    expect(decide({ id: "untitled-2.txt", click_count: 1 }).ok).toBe(true);
    expect(decide({ id: "untitled-2.txt", click_count: 2 }).ok).toBe(false);
  });

  it("the component renders the strings the step reads", () => {
    const client = readFileSync(resolve(ROOT, "components/optimistic-rollback-client.tsx"), "utf8");
    expect(client).toContain("data-testid={`item-${it.id}`}");
    expect(client).toContain('<span className="truncate text-sm font-mono">{it.name}</span>');
    expect(client).toContain("name: `${it.name} (improving…)`");
    expect(client).toContain("rolled back · {it.lastReason}");
  });
});
