/**
 * Three pieces of prose that drifted from the code they describe (#215).
 *
 *   1. docs/architecture.md said the mock text streamer's jitter is "skipped
 *      when seeded for tests". Since #206 `seed` seeds the jitter and keeps
 *      the delay; PR #210 changed only lib/mock-stream.ts and its tests.
 *   2. The header comment in components/tool-use-client.tsx sent
 *      `connecting` to `streaming_text` on `tool_use_start`. The handler and
 *      docs/tool-use-state-machine.md both go to `tool_called`.
 *   3. docs/tool-use-state-machine.md said `tool_running` shows a spinner.
 *      The component renders none.
 *
 * Each prose lock is paired with a control that pins the fact the prose has
 * to match, so the lock cannot go green by rewording the code instead.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { mockTextStream } from "@/lib/mock-stream";

const ROOT = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const ARCH = read("docs/architecture.md");
const STATE_DOC = read("docs/tool-use-state-machine.md");
const CLIENT = read("components/tool-use-client.tsx");

// The non-terminal SSE events: the ones whose transitions depend on the
// current phase. Terminal frames (`message_stop`, `error`) go to their
// terminal state from anywhere, and the header writes those as `*` rows.
const NON_TERMINAL_EVENTS = ["text_delta", "tool_use_start", "tool_use_stop", "tool_result"] as const;

/** `from|event` → `to`, from the header's `from → to (events)` rows. */
function headerTransitions(src: string): Map<string, string> {
  const header = src.slice(src.indexOf("/**"), src.indexOf("*/"));
  const out = new Map<string, string>();
  for (const m of header.matchAll(/^\s*\*\s+([a-z_]+)\s+→\s+([a-z_]+)\s+\(([^)]*)\)/gm)) {
    for (const ev of NON_TERMINAL_EVENTS) {
      if (new RegExp(`\\b${ev}\\b`).test(m[3])) out.set(`${m[1]}|${ev}`, m[2]);
    }
  }
  return out;
}

/** `from|event` → `to`, from the doc's `from ──event──▶ to` diagram lines. */
function docTransitions(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of md.matchAll(/^([a-z_]+) ──([a-z_]+)(?:\([^)]*\))?──▶ ([a-z_]+)/gm)) {
    out.set(`${m[1]}|${m[2]}`, m[3]);
  }
  return out;
}

describe("architecture.md: seeding does not skip the mock's delay (#215)", () => {
  const fallback = ARCH.slice(ARCH.indexOf("## The no-key fallback"));
  const para = fallback.slice(0, fallback.indexOf("\n\n", fallback.indexOf("`lib/anthropic-stream.ts`")));

  it("does not claim the jitter is skipped when seeded", () => {
    expect(para).toContain("lib/mock-stream.ts");
    expect(para).not.toMatch(/skipped when seeded|seed\w*\s+(skips|bypasses|disables)/i);
  });

  it("says what seed does, citing #206", () => {
    expect(para).toMatch(/`seed`/);
    expect(para).toContain("#206");
  });

  // Control: the fact the paragraph must match. A seeded stream still waits.
  it("control: a seeded mockTextStream still waits baseDelayMs per token", async () => {
    const start = Date.now();
    const gen = mockTextStream({ seed: 1, baseDelayMs: 15, jitterMs: 0 });
    for (let i = 0; i < 4; i++) expect((await gen.next()).done).toBe(false);
    await gen.return();
    // setTimeout can fire a hair early; 4 × 15 ms with slack still rules out "skipped".
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});

describe("tool-use-client.tsx header matches the state-machine doc (#215)", () => {
  const header = headerTransitions(CLIENT);
  const doc = docTransitions(STATE_DOC);

  it("parses enough of both to compare (anti-vacuity)", () => {
    expect(header.size).toBeGreaterThanOrEqual(5);
    expect(doc.get("connecting|tool_use_start")).toBe("tool_called");
    expect(header.has("connecting|tool_use_start")).toBe(true);
  });

  it("every non-terminal header transition agrees with the doc", () => {
    const mismatches: string[] = [];
    for (const [key, to] of header) {
      const docTo = doc.get(key);
      if (docTo === undefined) mismatches.push(`${key} → ${to} (not in doc)`);
      else if (docTo !== to) mismatches.push(`${key}: header ${to}, doc ${docTo}`);
    }
    expect(mismatches).toEqual([]);
  });

  // Control: the handler itself, which both pieces of prose describe.
  it("control: the tool_use_start handler sets tool_called unconditionally", () => {
    const start = CLIENT.indexOf('case "tool_use_start":');
    const block = CLIENT.slice(start, CLIENT.indexOf("case ", start + 1));
    expect(block).toContain('setPhase("tool_called")');
    expect(block).not.toMatch(/setPhase\(\s*\(/);
  });
});

describe("state-machine doc: tool_running row describes what renders (#215)", () => {
  const row = STATE_DOC.split("\n").find((l) => l.startsWith("| `tool_running`")) ?? "";

  it("finds the row (anti-vacuity)", () => {
    expect(row).toContain("tool_use_stop");
  });

  it("claims no spinner while the component renders none", () => {
    if (/animate-spin|spinner/i.test(CLIENT)) return; // a spinner exists; the claim would be true
    expect(row).not.toMatch(/spinner/i);
  });

  it("names the Run button's running… label, which the component does render", () => {
    expect(row).toContain("running…");
    expect(CLIENT).toContain('"running…"');
  });
});
