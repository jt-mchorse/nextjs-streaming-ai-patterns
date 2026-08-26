/**
 * One SSE frame parser, shared by all four streaming clients (#93).
 *
 * The parser existed in four inlined copies and they had diverged on four
 * inputs, three of them silently — a dropped frame produces no throw, no log,
 * and no state change. The table below is the one that surfaced the divergence:
 * each case was run through all four copies side by side.
 *
 * The repo's own routes emit only the canonical `event: x\ndata: {...}` form,
 * which is exactly why the divergence stayed invisible. The locks at the bottom
 * pin that canonical behaviour so this consolidation cannot change it.
 */

import { describe, expect, it } from "vitest";

import { parseSseFrame } from "@/lib/sse-stream";

describe("parseSseFrame — the four divergences", () => {
  it("accepts data: with no space, which three of four copies dropped silently", () => {
    // The space after the field name is optional in the SSE wire format.
    // `startsWith("data: ")` failed, dataLine stayed empty, and the whole frame
    // was discarded with no diagnostic.
    expect(parseSseFrame('event: text_delta\ndata:{"text":"hi"}')).toEqual({
      event: "text_delta",
      data: '{"text":"hi"}',
    });
  });

  it("accepts event: with no space, which produced three different answers", () => {
    // tool-use/partial-json fell back to "message" (matching no switch case,
    // so the payload was silently ignored); error-recovery reported null.
    expect(parseSseFrame('event:text_delta\ndata: {"text":"hi"}').event).toBe("text_delta");
  });

  it("accumulates data: lines rather than keeping only the last", () => {
    // error-recovery assigned (`=`) where the other three appended (`+=`), so
    // this payload lost its first line and then failed to parse.
    const { data } = parseSseFrame('data: {"a":1,\ndata: "b":2}');

    expect(data).toBe('{"a":1,"b":2}');
    expect(JSON.parse(data)).toEqual({ a: 1, b: 2 });
  });

  it("trims the value so CRLF framing does not corrupt the event name", () => {
    // error-recovery did not trim, so the event name kept its \r and every
    // `event === "..."` comparison downstream silently failed.
    const { event } = parseSseFrame('event: message_stop\r\ndata: {"ok":1}\r');

    expect(event).toBe("message_stop");
    expect(event === "message_stop").toBe(true);
  });
});

describe("parseSseFrame — fields that must stay ignored", () => {
  it("ignores comment lines", () => {
    expect(parseSseFrame(': keepalive\nevent: x\ndata: {"text":"hi"}')).toEqual({
      event: "x",
      data: '{"text":"hi"}',
    });
  });

  it("treats a comment that looks like a field as a comment", () => {
    // A leading colon marks the whole line as a comment, so ": data: x" must
    // not contribute a data value.
    expect(parseSseFrame(": data: sneaky\ndata: {}").data).toBe("{}");
  });

  it("ignores id: and retry:", () => {
    expect(parseSseFrame('id: 42\nretry: 3000\ndata: {"text":"hi"}')).toEqual({
      event: null,
      data: '{"text":"hi"}',
    });
  });

  it("ignores a line with no colon at all", () => {
    expect(parseSseFrame('garbage\ndata: {"text":"hi"}').data).toBe('{"text":"hi"}');
  });
});

describe("parseSseFrame — locks on the canonical form this repo emits", () => {
  it.each([
    ['event: text_delta\ndata: {"text":"hi"}', "text_delta", '{"text":"hi"}'],
    ["event: done\ndata: {}", "done", "{}"],
    ['event: error\ndata: {"error":"boom"}', "error", '{"error":"boom"}'],
    ['data: {"text":"hi"}', null, '{"text":"hi"}'],
  ])("parses %j unchanged", (frame, event, data) => {
    expect(parseSseFrame(frame as string)).toEqual({ event, data });
  });

  it("strips exactly one space, leaving any others in the value", () => {
    // Spec behaviour: one optional space is part of the framing, the rest is
    // payload.
    //
    // This assertion used to expect "x", with a parenthetical conceding that
    // "the trailing trim then removes it here" -- i.e. it asserted the opposite
    // of its own name and of the sentence above it. #107 removed the per-line
    // trim from `data` because it was deleting whitespace at every multi-line
    // split point, so the second space now survives and the test's name is
    // true. The `event` field, which is what the trim was actually added for
    // (#93), still gets the full trim; see the `event keeps the full trim`
    // block in `sse-frame-data-accumulation.test.ts`.
    expect(parseSseFrame("data:  x").data).toBe(" x");
  });

  it("reports an empty data value as empty, so callers still drop the frame", () => {
    expect(parseSseFrame("event: x\ndata: ").data).toBe("");
  });

  it("reports a frame with no data line as empty", () => {
    expect(parseSseFrame("event: x")).toEqual({ event: "x", data: "" });
  });
});
