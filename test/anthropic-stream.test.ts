/**
 * Entry-point validation tests for `lib/anthropic-stream.ts` (#32).
 *
 * Sibling to the per-streamer `validateOptions` tests already in place
 * for `mock-stream.ts`, `mock-json-stream.ts`, `mock-tool-stream.ts`,
 * and `checkpoint-stream.ts`. Closes the last unguarded entry points
 * in `lib/` so every public stream surface fails loud at the call site
 * rather than silently degenerating in `live` mode (SDK error at API
 * time) or `mock` mode (canned stream ignores prompt).
 *
 * `streamText` is exercised against an `undefined` API key environment
 * so the `mock` branch is taken — exercises the validation guard
 * without a real Anthropic round-trip.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_MODEL, getStreamMode, streamText } from "@/lib/anthropic-stream";

describe("validatePrompt — type rejection", () => {
  it("rejects a non-string with TypeError", async () => {
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gen = streamText(42 as any);
      await gen.next();
    }).rejects.toThrow(TypeError);
  });

  it("rejects null with TypeError", async () => {
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gen = streamText(null as any);
      await gen.next();
    }).rejects.toThrow(TypeError);
  });

  it("rejects undefined with TypeError", async () => {
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gen = streamText(undefined as any);
      await gen.next();
    }).rejects.toThrow(TypeError);
  });
});

describe("validatePrompt — value rejection", () => {
  it.each([
    ["empty string", ""],
    ["all whitespace (spaces)", "   "],
    ["all whitespace (tabs + newlines)", "\t\n\r "],
  ])("rejects %s with RangeError", async (_label, bad) => {
    await expect(async () => {
      const gen = streamText(bad);
      await gen.next();
    }).rejects.toThrow(RangeError);
  });

  it("RangeError message names the field and the contract", async () => {
    await expect(async () => {
      const gen = streamText("");
      await gen.next();
    }).rejects.toThrow(/prompt must be a non-empty, non-whitespace string/);
  });
});

describe("validatePrompt — accepts well-formed prompts (mock mode)", () => {
  // `mock` mode is selected via `getStreamMode()` — drive the test path
  // by ensuring ANTHROPIC_API_KEY is absent for this block.
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("accepts a normal prompt and yields { text } deltas", async () => {
    const gen = streamText("Write a haiku about streaming.");
    const chunks: string[] = [];
    for await (const chunk of gen) {
      expect(typeof chunk.text).toBe("string");
      chunks.push(chunk.text);
      if (chunks.length > 50) break; // safety cap
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("getStreamMode — ANTHROPIC_API_KEY shape", () => {
  let savedKey: string | undefined;
  let savedModel: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedModel = process.env.ANTHROPIC_MODEL;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = savedModel;
  });

  it("falls back to mock when ANTHROPIC_API_KEY is unset", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const info = getStreamMode();
    expect(info.mode).toBe("mock");
    expect(info.model).toBeNull();
  });

  it("falls back to mock when ANTHROPIC_API_KEY is empty", () => {
    process.env.ANTHROPIC_API_KEY = "";
    const info = getStreamMode();
    expect(info.mode).toBe("mock");
    expect(info.model).toBeNull();
  });

  it("falls back to mock when ANTHROPIC_API_KEY is whitespace-only (#32 hardening)", () => {
    // Pre-#32 `length > 0` accepted "   " as present and passed an
    // invalid bearer header to the SDK; #32 trims so whitespace = absent.
    process.env.ANTHROPIC_API_KEY = "   ";
    const info = getStreamMode();
    expect(info.mode).toBe("mock");
    expect(info.model).toBeNull();
  });

  it("selects live mode when ANTHROPIC_API_KEY is set to a real value", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const info = getStreamMode();
    expect(info.mode).toBe("live");
    expect(info.model).toBe(DEFAULT_MODEL);
  });

  it("trims surrounding whitespace from the API key", () => {
    process.env.ANTHROPIC_API_KEY = "  sk-ant-test-key  ";
    const info = getStreamMode();
    expect(info.mode).toBe("live");
  });
});

describe("getStreamMode — ANTHROPIC_MODEL shape", () => {
  let savedKey: string | undefined;
  let savedModel: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedModel = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = savedModel;
  });

  it("uses DEFAULT_MODEL when ANTHROPIC_MODEL is unset", () => {
    delete process.env.ANTHROPIC_MODEL;
    expect(getStreamMode().model).toBe(DEFAULT_MODEL);
  });

  it("uses DEFAULT_MODEL when ANTHROPIC_MODEL is empty string (#32 hardening)", () => {
    // Pre-#32 `process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL` accepted ""
    // and passed `model: ""` to the SDK, which surfaced as an API
    // error rather than failing loud against the local fallback.
    process.env.ANTHROPIC_MODEL = "";
    expect(getStreamMode().model).toBe(DEFAULT_MODEL);
  });

  it("uses DEFAULT_MODEL when ANTHROPIC_MODEL is whitespace-only (#32 hardening)", () => {
    process.env.ANTHROPIC_MODEL = "   ";
    expect(getStreamMode().model).toBe(DEFAULT_MODEL);
  });

  it("honors a real ANTHROPIC_MODEL override (trimmed)", () => {
    process.env.ANTHROPIC_MODEL = "  claude-opus-4-7  ";
    expect(getStreamMode().model).toBe("claude-opus-4-7");
  });
});
