/**
 * The `?checkpoint=` param resolved to a silently different position (#98).
 *
 * The route resolved `?checkpoint=` with `Number.parseInt`, whose prefix scan
 * the adjacent `Number.isInteger` check can never catch, and applied no upper
 * bound at all.
 *
 * The fix is confined to the ROUTE. I tried putting an upper bound in
 * `checkpoint-stream`'s `validateOptions` first and it turned a named existing
 * test red; see the last describe block for why the library is right to have
 * none.
 *
 * Measured on `main` @ 3208299 (TOTAL_TOKENS = 137), as
 * `frames | text-frames | event-kinds`:
 *
 *   "0"            15  12  {data:14, error:1}    <- documented drop
 *   "5"           159 132  {data:158, done:1}    <- documented clean resume
 *   "12"          151 125  {data:150, done:1}
 *   "999999"        1   0  {done:1}              <- 200 OK, demo shows nothing
 *   "1e5"         164 136  {data:163, done:1}    <- resumed from 1, not 100000
 *   "1e400"       164 136  {data:163, done:1}    <- resumed from 1
 *   "13.9"        150 124  {data:149, done:1}    <- resumed from 13
 *   "5abc"        159 132  {data:158, done:1}    <- resumed from 5
 *   " 7 "         157 130  {data:156, done:1}    <- resumed from 7
 *
 * Every assertion here is on **frame counts and event kinds**, not on a thrown
 * exception. The `?checkpoint=999999` failure produced a perfectly valid 200
 * response — an exception-shaped assertion would have missed the entire defect.
 */

import { describe, expect, it } from "vitest";

import { GET } from "../app/api/error-recovery/route";
import { TOTAL_TOKENS, streamCheckpoints } from "../lib/checkpoint-stream";

interface Shape {
  readonly frames: number;
  readonly textFrames: number;
  readonly events: Record<string, number>;
}

async function shapeOf(checkpoint: string): Promise<Shape> {
  const res = await GET(
    new Request(
      `http://localhost/api/error-recovery?checkpoint=${encodeURIComponent(checkpoint)}`,
    ) as never,
  );
  expect(res.status).toBe(200);
  const body = await res.text();
  const frames = body.split("\n\n").filter((f) => f.length > 0);
  const events: Record<string, number> = {};
  let textFrames = 0;
  for (const f of frames) {
    const m = /^event: (\S+)/.exec(f);
    const kind = m ? m[1] : "data";
    events[kind] = (events[kind] ?? 0) + 1;
    if (/"kind":"text"/.test(f)) textFrames += 1;
  }
  return { frames: frames.length, textFrames, events };
}

/** The shape a fresh request produces: 12 text tokens, then the simulated drop. */
const DROP_SHAPE: Shape = { frames: 15, textFrames: 12, events: { data: 14, error: 1 } };

describe("?checkpoint= domain (#98)", () => {
  describe("(A) an out-of-range checkpoint no longer yields a successful empty stream", () => {
    it.each(["138", "999999", "999999999999"])(
      "?checkpoint=%s produces the drop stream, not one lone done frame",
      async (param) => {
        // Pre-fix: `{ frames: 1, textFrames: 0, events: { done: 1 } }` — HTTP
        // 200, well-formed SSE, and a demo whose entire point is showing
        // recovered prose rendering nothing at all. Nothing downstream could
        // tell that from a working run.
        expect(await shapeOf(param)).toEqual(DROP_SHAPE);
      },
    );

    it("?checkpoint=137 (exactly TOTAL_TOKENS) is still a legitimate empty resume", () => {
      // The boundary is inclusive on purpose: resuming past the *last* token is
      // reachable from a clean run that dropped on the final token, and an
      // empty-but-complete stream is the correct answer there. Getting this
      // wrong would turn a real resume into a spurious replay.
      expect(TOTAL_TOKENS).toBe(137);
      return expect(shapeOf(String(TOTAL_TOKENS))).resolves.toEqual({
        frames: 1,
        textFrames: 0,
        events: { done: 1 },
      });
    });
  });

  describe("(B) parseInt's prefix scan no longer resolves to a different position", () => {
    it.each([
      ["1e5", "parseInt stops at the `e`, so this resumed from 1 — not 100000"],
      ["1e400", 'an "effectively infinite" checkpoint resumed from 1'],
      ["13.9", "resumed from 13 — a plausible number, silently not the one asked for"],
      ["5abc", "resumed from 5"],
      [" 7 ", "resumed from 7"],
      ["+5", "a signed literal"],
      ["5.0", "an integral decimal is still not an integer literal"],
    ])("?checkpoint=%s clamps to 0 instead (%s)", async (param) => {
      // The route's posture has always been "anything invalid means a fresh
      // request". These are the values that were neither validated nor clamped:
      // they became a *different, plausible* position with no signal.
      expect(await shapeOf(param)).toEqual(DROP_SHAPE);
    });

    it("a 20-digit literal clamps rather than becoming a rounded float", async () => {
      // `Number("99999999999999999999")` is 1e20, which `Number.isInteger`
      // reports true for while no longer being the value that was typed. Hence
      // `isSafeInteger`, not `isInteger`.
      expect(await shapeOf("99999999999999999999")).toEqual(DROP_SHAPE);
    });
  });

  describe("what must not change", () => {
    it.each([
      ["0", 15, 12, { data: 14, error: 1 }],
      ["5", 159, 132, { data: 158, done: 1 }],
      ["12", 151, 125, { data: 150, done: 1 }],
    ])(
      "?checkpoint=%s is byte-shape-identical to pre-fix (the documented cases)",
      async (param, frames, textFrames, events) => {
        expect(await shapeOf(param as string)).toEqual({ frames, textFrames, events });
      },
    );

    it.each(["abc", "", "NaN", "-3", "0x10", "null", "undefined"])(
      "?checkpoint=%s already clamped to 0 and still does",
      async (param) => {
        // These are the shapes the old code handled correctly. The strict parse
        // must not narrow working behaviour, only widen the rejected set to
        // include the prefix class.
        expect(await shapeOf(param)).toEqual(DROP_SHAPE);
      },
    );

    it("a missing ?checkpoint= is still treated as a fresh request", async () => {
      const res = await GET(new Request("http://localhost/api/error-recovery") as never);
      const body = await res.text();
      const frames = body.split("\n\n").filter((f) => f.length > 0);
      expect(frames).toHaveLength(15);
      expect(frames.some((f) => f.startsWith("event: error"))).toBe(true);
    });

    it("leading zeros are still a valid decimal integer", async () => {
      // `007` is an ordinary non-negative decimal literal; rejecting it would be
      // gratuitous. It resolves to 7, the same position `7` does.
      expect(await shapeOf("007")).toEqual(await shapeOf("7"));
    });
  });

  describe("the library deliberately has NO upper bound — this is the route's job", () => {
    // I built the upper bound into `validateOptions` first, and it turned a
    // NAMED existing test red: "startAfter beyond TOTAL_TOKENS yields no text
    // events and no checkpoints" (test/checkpoint-stream.test.ts). Reverted,
    // and the reason is worth pinning rather than leaving as a silent omission.
    //
    // The existing lower bounds reject values that make the generator do
    // something ACTIVELY WRONG: `dropAfter = 0` fires the drop on the *first*
    // text event, contradicting its own docstring, and a negative/NaN
    // `startAfter` silently devolves to the default with no signal.
    //
    // An out-of-range *upper* value is a different class. `streamCheckpoints({
    // startAfter: n })` means "yield the tokens after n"; when n >= the total,
    // yielding nothing is the coherent answer, not a misconfiguration. Same for
    // `dropAfter` past the end: "drop after N more tokens" where N exceeds what
    // remains simply means no drop. Those are total functions.
    //
    // The 200-with-zero-text response is an OPERATOR-INPUT problem, and the
    // operator-input boundary is the route. That is where the clamp lives.

    it("startAfter past the end still yields an empty stream, as the named test requires", async () => {
      const events = [];
      for await (const e of streamCheckpoints({ startAfter: TOTAL_TOKENS + 9999 })) {
        events.push(e);
      }
      expect(events).toHaveLength(0);
    });

    it("dropAfter past the end still means no drop rather than a throw", async () => {
      // The sibling of the case above, pinned for the same reason: a future
      // author reading only the route fix should not "complete" it by adding an
      // upper bound here.
      let text = 0;
      for await (const e of streamCheckpoints({ dropAfter: TOTAL_TOKENS + 1 })) {
        if (e.kind === "text") text += 1;
      }
      expect(text).toBe(TOTAL_TOKENS);
    });

    it("the pre-existing lower bounds — the actively-wrong class — are untouched", async () => {
      async function firstEvent(options: Parameters<typeof streamCheckpoints>[0]) {
        const it = streamCheckpoints(options);
        await it.next();
      }
      await expect(firstEvent({ startAfter: -1 })).rejects.toThrow(
        /startAfter must be an integer >= 0/,
      );
      await expect(firstEvent({ dropAfter: 0 })).rejects.toThrow(
        /dropAfter must be an integer >= 1/,
      );
      await expect(firstEvent({ startAfter: 1.5 })).rejects.toThrow(
        /startAfter must be an integer >= 0/,
      );
    });
  });
});
