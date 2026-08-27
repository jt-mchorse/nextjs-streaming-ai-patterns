/**
 * The per-line trim deleted whitespace at every `data:` split point (#107).
 *
 * `parseSseFrame` trimmed every field value *before* accumulating `data:`
 * lines, so a payload split across two lines lost whitespace at the seam. The
 * corrupted result still `JSON.parse`d cleanly, so nothing errored — a text
 * delta just quietly lost a space. Measured on `main` before this change:
 *
 *     frame                                     parsed data
 *     data: {"text":"hello \ndata: world"}      {"text":"helloworld"}   <- space gone
 *     data: {"text":"hello\ndata:  world"}      {"text":"helloworld"}   <- space gone
 *     data: {"text":"hel\ndata: lo"}            {"text":"hello"}        <- correct
 *     data: {"text":"hello "}                   {"text":"hello "}       <- correct
 *
 * The same docstring carried both halves of the contradiction. The trim was
 * justified by "the value must be trimmed … under CRLF framing the event name
 * kept its `\r`" — a rule about `event`. Two paragraphs later, joining `data:`
 * lines without a separator is justified as "what makes a JSON object split
 * across `data:` lines reassemble, so it is preserved deliberately". The trim
 * broke the feature that paragraph preserves deliberately.
 *
 * And the trim's stated reason is no longer load-bearing, by the repo's own
 * words: `createSseFramer` normalizes `\r\n` and `\r` to `\n` before framing,
 * and its comment says that "keeps the parser's `\r` trim harmless rather than
 * load-bearing". Since #106 every in-repo SSE reader goes through the framer.
 * The `\r` strip is kept anyway, narrowed to a single trailing `\r`, for a
 * direct caller of this exported function who did not come through the framer.
 *
 * No in-repo route emits multi-line `data:` — each `send` writes one
 * `data: ${payload}\n\n` — so this was latent for the shipped demo and
 * reachable for any caller of the exported parser whose upstream splits a large
 * payload across `data:` lines. That is legal SSE, and this parser documents
 * itself as supporting it.
 */

import { describe, expect, it } from "vitest";

import { parseSseFrame } from "@/lib/sse-stream";

// Built from a codepoint so the literal never rides through an editor or a
// tool that might normalize it.
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);

describe("parseSseFrame — a data: payload split across lines reassembles", () => {
  // (label, frame, expected data) — the table from the issue, verbatim.
  const table: ReadonlyArray<readonly [string, string, string]> = [
    [
      "split immediately after a space",
      'data: {"text":"hello \ndata: world"}',
      '{"text":"hello world"}',
    ],
    [
      "split immediately before a space",
      'data: {"text":"hello\ndata:  world"}',
      '{"text":"hello world"}',
    ],
    ["split mid-word (control)", 'data: {"text":"hel\ndata: lo"}', '{"text":"hello"}'],
    ["single line, trailing space (control)", 'data: {"text":"hello "}', '{"text":"hello "}'],
    [
      "split at a tab",
      `data: {"text":"a\ndata: ${TAB}b"}`,
      `{"text":"a${TAB}b"}`,
    ],
    [
      "three-way split with spaces at both seams",
      'data: {"t":"a \ndata: b \ndata: c"}',
      '{"t":"a b c"}',
    ],
    [
      "split with the compact (no-space) continuation form",
      'data: {"text":"hello \ndata:world"}',
      '{"text":"hello world"}',
    ],
  ];

  it.each(table)("%s", (_label, frame, expected) => {
    expect(parseSseFrame(frame).data).toBe(expected);
  });

  it("the reassembled payloads are the ones that actually parse to the right value", () => {
    // The corrupted rows parsed cleanly too — that is why this was silent. So
    // assert the *parsed value*, not merely that parsing succeeds.
    const { data } = parseSseFrame('data: {"text":"hello \ndata: world"}');
    expect(JSON.parse(data)).toEqual({ text: "hello world" });
  });

  it("does not depend on the payload being JSON", () => {
    expect(parseSseFrame("data: alpha \ndata: beta").data).toBe("alpha beta");
  });
});

describe("parseSseFrame — the \\r protection the old trim claimed is kept", () => {
  it("strips a single trailing CR from a data line", () => {
    expect(parseSseFrame(`data: {"a":1}${CR}`).data).toBe('{"a":1}');
  });

  it("strips a trailing CR from an event line, which is what #93's note is about", () => {
    expect(parseSseFrame(`event: message_stop${CR}\ndata: {"ok":1}${CR}`).event).toBe(
      "message_stop",
    );
  });

  it("a whole CRLF frame yields a CR-free event and data", () => {
    const frame = `event: done${CR}\ndata: {"total":3}${CR}`;
    expect(parseSseFrame(frame)).toEqual({ event: "done", data: '{"total":3}' });
  });

  it("strips only one CR, because a second one is payload", () => {
    expect(parseSseFrame(`data: a${CR}${CR}`).data).toBe(`a${CR}`);
  });

  it("keeps a trailing space that is not a CR", () => {
    // The exact byte the old trim was eating.
    expect(parseSseFrame("data: a \ndata: b").data).toBe("a b");
  });

  it("keeps whitespace before a trailing CR", () => {
    expect(parseSseFrame(`data: a ${CR}\ndata: b`).data).toBe("a b");
  });
});

describe("parseSseFrame — event keeps the full trim", () => {
  it.each([
    ["trailing CR", `event: done${CR}`],
    ["trailing space", "event: done "],
    ["trailing tab", `event: done${TAB}`],
    ["surrounding whitespace", `event:  done ${CR}`],
  ])("%s", (_label, frame) => {
    // `event === "..."` comparisons run all over the four clients; an event
    // name with meaningful surrounding whitespace is not a thing.
    expect(parseSseFrame(frame).event).toBe("done");
  });
});

describe("parseSseFrame — the canonical in-repo form is unchanged", () => {
  // The shipped routes emit exactly this. Nothing about it may move.
  it.each([
    ['event: text_delta\ndata: {"text":"hi"}', "text_delta", '{"text":"hi"}'],
    ['event: text_delta\ndata:{"text":"hi"}', "text_delta", '{"text":"hi"}'],
    ['data: {"text":"hi"}', null, '{"text":"hi"}'],
    ["event: done\ndata: {}", "done", "{}"],
    [': keepalive\nevent: x\ndata: {"text":"hi"}', "x", '{"text":"hi"}'],
    ['id: 42\nretry: 3000\ndata: {"text":"hi"}', null, '{"text":"hi"}'],
  ])("%s", (frame, event, data) => {
    expect(parseSseFrame(frame)).toEqual({ event, data });
  });

  it("an empty data field is still the empty string", () => {
    expect(parseSseFrame("data:").data).toBe("");
    expect(parseSseFrame("data: ").data).toBe("");
  });

  it("a whitespace-only data line is now whitespace, and every consumer still skips it", () => {
    // Behaviour change, stated rather than hidden: `data:   ` used to trim to
    // "" and now yields "  ". All four clients guard with `!dataLine` /
    // `.length === 0` and then `JSON.parse` inside a try/catch that returns on
    // failure — so the frame is skipped either way, by the catch instead of by
    // the emptiness guard. No in-repo route can emit this shape: each `send`
    // writes one `data: ${JSON.stringify(...)}\n\n`.
    expect(parseSseFrame("data:   ").data).toBe("  ");
    expect(() => JSON.parse(parseSseFrame("data:   ").data)).toThrow();
  });
});

describe("anti-vacuous", () => {
  it("every split row in the table really is split, and really has whitespace at a seam", () => {
    const splitFrames = [
      'data: {"text":"hello \ndata: world"}',
      'data: {"text":"hello\ndata:  world"}',
      'data: {"t":"a \ndata: b \ndata: c"}',
    ];
    for (const frame of splitFrames) {
      const dataLines = frame.split("\n").filter((l) => l.startsWith("data:"));
      expect(dataLines.length).toBeGreaterThan(1);
      // The old code path: trim each line, then concatenate. If that produced
      // the same answer as the new code, the row would prove nothing.
      const oldWay = dataLines
        .map((l) => {
          let v = l.slice(l.indexOf(":") + 1);
          if (v.startsWith(" ")) v = v.slice(1);
          return v.trim();
        })
        .join("");
      expect(oldWay).not.toBe(parseSseFrame(frame).data);
    }
  });
});
