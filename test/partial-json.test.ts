import { describe, expect, it } from "vitest";
import { parsePartialJson } from "../lib/partial-json";

describe("parsePartialJson — happy paths", () => {
  it("returns null for an empty buffer", () => {
    const result = parsePartialJson("");
    expect(result).toEqual({ value: null, isComplete: false });
  });

  it("returns null for whitespace-only input", () => {
    const result = parsePartialJson("   \n  ");
    expect(result).toEqual({ value: null, isComplete: false });
  });

  it("parses a complete JSON object as isComplete=true", () => {
    const result = parsePartialJson('{"a": 1, "b": "two"}');
    expect(result.value).toEqual({ a: 1, b: "two" });
    expect(result.isComplete).toBe(true);
  });

  it("parses a complete JSON array as isComplete=true", () => {
    const result = parsePartialJson("[1, 2, 3]");
    expect(result.value).toEqual([1, 2, 3]);
    expect(result.isComplete).toBe(true);
  });
});

describe("parsePartialJson — incomplete objects", () => {
  it("returns the closed-up prefix when the trailing key has no value", () => {
    const result = parsePartialJson('{"a": 1, "b":');
    expect(result.value).toEqual({ a: 1 });
    expect(result.isComplete).toBe(false);
  });

  it("returns the closed-up prefix when the trailing value is an open string", () => {
    const result = parsePartialJson('{"a": 1, "b": "hel');
    expect(result.value).toEqual({ a: 1 });
    expect(result.isComplete).toBe(false);
  });

  it("returns the closed-up prefix when the trailing value is a half-typed key", () => {
    const result = parsePartialJson('{"a": 1, "b": 2, "c');
    expect(result.value).toEqual({ a: 1, b: 2 });
    expect(result.isComplete).toBe(false);
  });

  it("handles a trailing comma without a following key", () => {
    const result = parsePartialJson('{"a": 1,');
    expect(result.value).toEqual({ a: 1 });
    expect(result.isComplete).toBe(false);
  });

  it("recovers when a partial number is mid-token", () => {
    // 'tru' (incomplete `true`) should drop back to before the partial literal.
    const result = parsePartialJson('{"a": 1, "b": tru');
    expect(result.value).toEqual({ a: 1 });
    expect(result.isComplete).toBe(false);
  });
});

describe("parsePartialJson — incomplete arrays", () => {
  it("returns the elements parsed so far when the array is open", () => {
    const result = parsePartialJson("[1, 2, 3");
    expect(result.value).toEqual([1, 2, 3]);
    expect(result.isComplete).toBe(false);
  });

  it("handles a trailing comma in an array", () => {
    const result = parsePartialJson("[1, 2,");
    expect(result.value).toEqual([1, 2]);
    expect(result.isComplete).toBe(false);
  });

  it("returns prior elements when the next element is a partial string", () => {
    const result = parsePartialJson('["a", "b", "ne');
    expect(result.value).toEqual(["a", "b"]);
    expect(result.isComplete).toBe(false);
  });
});

describe("parsePartialJson — nested structures", () => {
  it("returns deeply nested values with open inner structures closed", () => {
    const result = parsePartialJson('{"trip": {"city": "Austin", "days": [1, 2');
    expect(result.value).toEqual({ trip: { city: "Austin", days: [1, 2] } });
    expect(result.isComplete).toBe(false);
  });

  it("returns nested array of objects, dropping the half-typed last entry", () => {
    const result = parsePartialJson('{"items": [{"id": 1}, {"id": 2}, {"id":');
    const value = result.value as { items: { id: number }[] };
    expect(value.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.isComplete).toBe(false);
  });

  it("handles an escaped quote inside a string value", () => {
    const result = parsePartialJson('{"note": "she said \\"hello\\" then');
    // The string is still open — should drop the whole field.
    expect(result.value).toEqual({});
    expect(result.isComplete).toBe(false);
  });

  it("handles a fully-closed string with an embedded escape", () => {
    const result = parsePartialJson('{"note": "she said \\"hi\\"", "next');
    const value = result.value as { note: string };
    expect(value.note).toBe('she said "hi"');
    expect(result.isComplete).toBe(false);
  });
});

describe("parsePartialJson — malformed-tolerance (acceptance criteria)", () => {
  it("returns null for a top-level half-typed literal", () => {
    const result = parsePartialJson("tru");
    expect(result).toEqual({ value: null, isComplete: false });
  });

  it("returns null for input that's syntactically un-fixable", () => {
    // ']' before '[' is unrecoverable.
    const result = parsePartialJson("]");
    expect(result.value).toBeNull();
    expect(result.isComplete).toBe(false);
  });

  it("never throws on adversarial input", () => {
    const adversarial = [
      '{"a": "open string',
      '{"a": [1, "two", {',
      '{"a": "ok", "b": "nested \\"open',
      '{,,,}',
      "[[[[",
      '{"a": 1, "b": {"c":',
    ];
    for (const input of adversarial) {
      expect(() => parsePartialJson(input)).not.toThrow();
    }
  });
});

describe("parsePartialJson — incremental sequence", () => {
  it("returns monotonically-improving values as chunks accumulate", () => {
    const target = '{"destination": "Austin", "days": 3, "stops": ["BBQ", "music"]}';
    const checkpoints = [target.length / 6, target.length / 3, target.length / 2, target.length];
    const snapshots: { idx: number; value: unknown }[] = [];
    for (const c of checkpoints) {
      const slice = target.slice(0, Math.floor(c));
      snapshots.push({ idx: Math.floor(c), value: parsePartialJson(slice).value });
    }
    // Final snapshot must equal the fully parsed target.
    expect(snapshots[snapshots.length - 1]?.value).toEqual(JSON.parse(target));
    // Earlier snapshots should be sub-objects whose keys are all in the target.
    for (const s of snapshots.slice(0, -1)) {
      if (s.value && typeof s.value === "object") {
        const keys = Object.keys(s.value as Record<string, unknown>);
        for (const k of keys) {
          expect(JSON.parse(target)).toHaveProperty(k);
        }
      }
    }
  });
});

describe("parsePartialJson — trailing junk after a complete top-level value", () => {
  it("surfaces the committed object when junk follows the close brace", () => {
    expect(parsePartialJson('{"a":1}extra')).toEqual({ value: { a: 1 }, isComplete: false });
  });

  it("surfaces the committed array when junk follows the close bracket", () => {
    expect(parsePartialJson("[1,2]extra")).toEqual({ value: [1, 2], isComplete: false });
  });

  it("surfaces a bare top-level value when junk follows", () => {
    expect(parsePartialJson("42 junk")).toEqual({ value: 42, isComplete: false });
  });
});

describe("parsePartialJson — malformed/truncated string escapes (#50)", () => {
  // The bug: consumeString tracked escape state but never validated the
  // escape, so a closed string with an invalid escape was reported complete,
  // JSON.parse then threw on the repaired buffer, and the catch-all nulled
  // EVERY field — including ones fully transmitted before the bad string.

  it("preserves prior committed fields when a closed string has a non-hex \\u escape", () => {
    expect(parsePartialJson('{"a": 1, "b": "\\uXYZW"}')).toEqual({ value: { a: 1 }, isComplete: false });
  });

  it("preserves prior committed fields on an invalid single-char escape (\\q)", () => {
    expect(parsePartialJson('{"a": 1, "b": "\\q"}')).toEqual({ value: { a: 1 }, isComplete: false });
  });

  it("preserves prior committed fields when a \\u escape is closed with too few hex digits", () => {
    expect(parsePartialJson('{"keep": 42, "bad": "x\\u12"}')).toEqual({ value: { keep: 42 }, isComplete: false });
  });

  it("preserves prior committed fields when a \\u escape is truncated at end of buffer", () => {
    expect(parsePartialJson('{"keep": 42, "bad": "x\\u12')).toEqual({ value: { keep: 42 }, isComplete: false });
  });

  it("preserves prior committed fields on a dangling backslash at end of buffer", () => {
    expect(parsePartialJson('{"keep": 7, "bad": "x\\')).toEqual({ value: { keep: 7 }, isComplete: false });
  });

  it("drops an entire array element with a malformed escape but keeps earlier elements", () => {
    expect(parsePartialJson('[1, 2, "\\uZZZZ"]')).toEqual({ value: [1, 2], isComplete: false });
  });

  it("returns null for a bare malformed top-level string (nothing was validly transmitted)", () => {
    expect(parsePartialJson('"\\q"')).toEqual({ value: null, isComplete: false });
  });

  // Regressions: well-formed escapes must keep parsing exactly as before.
  it("still parses valid control escapes (\\n) to completion", () => {
    expect(parsePartialJson('{"a": 1, "b": "ok\\n"}')).toEqual({ value: { a: 1, b: "ok\n" }, isComplete: true });
  });

  it("still parses a valid \\uXXXX escape to completion", () => {
    expect(parsePartialJson('"\\uABCD"')).toEqual({ value: "ꯍ", isComplete: true });
  });

  it("still parses all single-char escapes (\\\" \\\\ \\/) to completion", () => {
    expect(parsePartialJson('{"p": "a\\"b\\\\c\\/d"}')).toEqual({ value: { p: 'a"b\\c/d' }, isComplete: true });
  });
});

describe("parsePartialJson — unescaped control characters in strings (#52)", () => {
  // Sibling of #50: JSON forbids literal control characters (U+0000–U+001F)
  // inside string literals, so JSON.parse rejects the whole document.
  // consumeString validated escapes but walked past a literal control char and
  // reported complete:true, so the repaired buffer's JSON.parse threw and the
  // catch-all nulled EVERY field — including ones fully transmitted before it.
  // Fix: treat an unescaped control char as closed-form corruption (return
  // null → drop-and-keep), preserving prior committed siblings.

  it("preserves prior committed fields when a string holds a literal newline", () => {
    expect(parsePartialJson('{"a": 1, "b": "y\nz"}')).toEqual({ value: { a: 1 }, isComplete: false });
  });

  it("preserves prior committed fields when a string holds a literal tab", () => {
    expect(parsePartialJson('{"a": 1, "b": "y\tz"}')).toEqual({ value: { a: 1 }, isComplete: false });
  });

  it("preserves prior committed fields on a low control char (\\x01)", () => {
    expect(parsePartialJson('{"keep": 42, "bad": "x\x01y"}')).toEqual({ value: { keep: 42 }, isComplete: false });
  });

  it("drops an array element with a literal control char but keeps earlier elements", () => {
    expect(parsePartialJson('[1, 2, "a\nb"]')).toEqual({ value: [1, 2], isComplete: false });
  });

  it("returns null for a bare top-level string containing a control char", () => {
    expect(parsePartialJson('"a\nb"')).toEqual({ value: null, isComplete: false });
  });

  // Regressions: properly *escaped* control chars must still parse to completion.
  it("still parses an escaped newline (\\n) to completion", () => {
    expect(parsePartialJson('{"a": 1, "b": "y\\nz"}')).toEqual({ value: { a: 1, b: "y\nz" }, isComplete: true });
  });

  it("still parses an escaped tab (\\t) to completion", () => {
    expect(parsePartialJson('{"a": "x\\ty"}')).toEqual({ value: { a: "x\ty" }, isComplete: true });
  });
});
