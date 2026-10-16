import { describe, expect, it } from "vitest";

import { parsePartialJson } from "../lib/partial-json";

// #181: the scanner's whitespace has to be JSON's (space, tab, LF, CR). It was
// `/\s/`, so a codepoint `JSON.parse` rejects between tokens was skipped by the
// scanner, copied into the repaired candidate, and the candidate's parse failed
// -- nulling every committed field. A stray `x` in the same position already
// kept them; these characters must get the same drop-and-keep handling.
//
// Built from codepoints, not literals: several of these do not survive an
// editor or a copy-paste round trip.
const NON_JSON_WHITESPACE: ReadonlyArray<[string, number]> = [
  ["VT", 0x0b],
  ["FF", 0x0c],
  ["NBSP", 0xa0],
  ["ZWNBSP/BOM", 0xfeff],
  ["LINE SEPARATOR", 0x2028],
  ["PARAGRAPH SEPARATOR", 0x2029],
  ["IDEOGRAPHIC SPACE", 0x3000],
];

describe("parsePartialJson — non-JSON whitespace outside a string (#181)", () => {
  for (const [name, cp] of NON_JSON_WHITESPACE) {
    const w = String.fromCodePoint(cp);

    it(`keeps committed object members when ${name} precedes the next key`, () => {
      expect(parsePartialJson(`{"a":1,"b":2,${w}"c":3`).value).toEqual({ a: 1, b: 2 });
    });

    it(`keeps committed object members when ${name} sits between members`, () => {
      const r = parsePartialJson(`{"a":1,"b":"x"${w},"c":3}`);
      expect(r.value).toEqual({ a: 1, b: "x" });
      expect(r.isComplete).toBe(false);
    });

    it(`keeps committed array elements when ${name} precedes the next element`, () => {
      expect(parsePartialJson(`[1,2,${w}3`).value).toEqual([1, 2]);
    });

    // VT and FF are below U+0020, so a raw one inside a string is the #52
    // control-character case and is dropped there by design.
    if (cp >= 0x20) {
      it(`still parses ${name} inside a string value`, () => {
        const r = parsePartialJson(`{"a":"x${w}y"}`);
        expect(r.value).toEqual({ a: `x${w}y` });
        expect(r.isComplete).toBe(true);
      });
    }
  }

  // The control row: the case that already behaved. If this goes red the test
  // above is no longer comparing against drop-and-keep.
  it("a stray non-whitespace character in the same position keeps the same prefix", () => {
    expect(parsePartialJson('{"a":1,"b":2,x"c":3').value).toEqual({ a: 1, b: 2 });
  });

  it("JSON's own four whitespace characters are still skipped between tokens", () => {
    const doc = '{ "a" :\t1 ,\n"b" :\r\n[ 2 , 3 ] ,\r"c": "z" }';
    expect(parsePartialJson(doc)).toEqual({
      value: { a: 1, b: [2, 3], c: "z" },
      isComplete: true,
    });
    // ...and in the repair path, where the scanner (not JSON.parse) reads them.
    expect(parsePartialJson('{ "a" :\t1 ,\n"b" :\r\n[ 2 , 3 ,\r').value).toEqual({
      a: 1,
      b: [2, 3],
    });
  });
});
