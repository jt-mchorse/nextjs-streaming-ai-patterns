/**
 * A frame ended by a bare CR is returned by the `push` that completes it (#187).
 *
 * `createSseFramer().push()` held a chunk-final `\r` back, because it could not
 * yet tell a lone CR from the first half of a `\r\n`. The line had ended either
 * way, so a frame that `\r` completed sat undelivered until the NEXT read, and
 * the last frame until the stream closed: measured on main, an upstream sending
 * `data: {"text":"hello"}\r\r` and staying open 1000 ms delivered it at
 * +1005 ms. That is #183's one-event-late symptom in the repo's own framer.
 */
import { describe, expect, it } from "vitest";

import { createSseFramer, pumpSseFrames } from "@/lib/sse-stream";

describe("every terminator form completes its frame in the same push", () => {
  it.each([
    ["LF", "data: a\n\n"],
    ["CRLF", "data: a\r\n\r\n"],
    ["CR", "data: a\r\r"],
    ["LF line, CR blank", "data: a\n\r"],
    ["CR line, LF blank", "data: a\r\n"],
    ["CRLF line, CR blank", "data: a\r\n\r"],
  ])("%s", (_label, body) => {
    // "CR line, LF blank" is `\r\n`: ONE line end, so no frame yet, and that
    // must not change.
    const framer = createSseFramer();
    const expected = body === "data: a\r\n" ? [] : ["data: a"];
    expect(framer.push(body)).toEqual(expected);
    expect(framer.flush()).toEqual([]);
  });
});

describe("a CRLF split across reads is still one line end", () => {
  it("the \\n opening the next read is swallowed exactly once", () => {
    const framer = createSseFramer();
    expect(framer.push("data: a\r\n\r")).toEqual(["data: a"]);
    // A frame boundary must not be manufactured from `\r` + `\n`.
    expect(framer.push("\ndata: b\r\n\r\n")).toEqual(["data: b"]);
  });

  it("an empty read between the halves does not lose the pairing", () => {
    const framer = createSseFramer();
    expect(framer.push("data: a\r")).toEqual([]);
    expect(framer.push("")).toEqual([]);
    expect(framer.push("\n\r\n")).toEqual(["data: a"]);
  });

  it("only the FIRST \\n after the CR is swallowed", () => {
    const framer = createSseFramer();
    expect(framer.push("data: a\r")).toEqual([]);
    expect(framer.push("\n\n")).toEqual(["data: a"]);
  });
});

describe("chunking never changes the frames (exhaustive)", () => {
  // Every way of cutting each body into three pieces must give the frames that
  // pushing it whole gives. This is the property the hold-back protected, so a
  // wrong fix that dropped any leading `\n` (or none) shows up here.
  const BODIES = [
    "event: a\rdata: 1\r\revent: b\rdata: 2\r\r",
    "event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n",
    "event: a\ndata: 1\r\n\revent: b\r\ndata: 2\n\r\n",
    "data: x\r\r\r\ndata: y\n\n\r\r",
  ];

  it.each(BODIES.map((b) => [JSON.stringify(b), b]))("%s", (_label, body) => {
    const whole = createSseFramer();
    const expected = [...whole.push(body), ...whole.flush()];
    expect(expected.length).toBeGreaterThan(0);
    let cases = 0;
    for (let i = 0; i <= body.length; i++) {
      for (let j = i; j <= body.length; j++) {
        const f = createSseFramer();
        const got = [
          ...f.push(body.slice(0, i)),
          ...f.push(body.slice(i, j)),
          ...f.push(body.slice(j)),
          ...f.flush(),
        ];
        expect(got, `cut at ${i}/${j}`).toEqual(expected);
        cases++;
      }
    }
    expect(cases).toBeGreaterThan(100);
  });
});

describe("pumpSseFrames delivers a CR-ended frame before the upstream closes", () => {
  it("within the read that carried it, not at end of stream", async () => {
    const enc = new TextEncoder();
    let close!: () => void;
    const closed = new Promise<void>((resolve) => (close = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode('data: {"text":"hello"}\r\r'));
        await closed;
        controller.close();
      },
    });
    const frames: string[] = [];
    let deliveredBeforeClose = false;
    const pumped = pumpSseFrames(body.getReader(), (frame) => {
      frames.push(frame);
      deliveredBeforeClose = true;
    });
    // Let the first read land, then look before releasing the upstream.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const seenWhileOpen = deliveredBeforeClose;
    close();
    await pumped;
    expect(seenWhileOpen).toBe(true);
    expect(frames).toEqual(['data: {"text":"hello"}']);
  });
});
