import { NextRequest } from "next/server";

import {
  CheckpointStreamDropped,
  TOTAL_TOKENS,
  streamCheckpoints,
} from "@/lib/checkpoint-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DROP_AFTER_TOKENS = 12;

/**
 * Resolve `?checkpoint=` to a usable resume position, or 0.
 *
 * The route's posture has always been "anything invalid means a fresh
 * request" — `abc`, `""`, `NaN`, `-3` and `0x10` all became 0 and took the
 * documented drop branch. That posture is kept exactly. What changes is the
 * one shape the previous code could not see (#98).
 *
 * It read `Number.parseInt(raw, 10)` and then checked
 * `Number.isInteger(n) && n >= 0`. That check *looks* like validation and can
 * never fail for a numeric-prefix string, because `parseInt` has already
 * discarded the rest of it. Measured:
 *
 *   ?checkpoint=1e5    -> resumed from 1       (parseInt stops at the `e`)
 *   ?checkpoint=1e400  -> resumed from 1
 *   ?checkpoint=13.9   -> resumed from 13
 *   ?checkpoint=5abc   -> resumed from 5
 *   ?checkpoint=" 7 "  -> resumed from 7
 *
 * Each is a *different, plausible* position from the one the caller asked for,
 * delivered with no signal. `Number("1e5")` is `100000` and `Number("13.9")` is
 * `13.9`; the leniency is entirely `parseInt`'s prefix scan.
 *
 * Out-of-range is clamped here too. `startAfter > TOTAL_TOKENS` produced a 200
 * with a single `event: done` frame and zero text frames — a well-formed
 * response, a correct status, and a demo whose entire point is showing recovered
 * prose rendering nothing. A demo endpoint should show the demo, so a nonsense
 * value here means "start over", like every other nonsense value.
 *
 * The bound lives HERE and deliberately not in `checkpoint-stream`'s
 * `validateOptions`. That guard rejects values that make the generator do
 * something actively wrong (`dropAfter = 0` fires the drop on the *first* text
 * event, contradicting its own docstring). An out-of-range upper value is a
 * different class: `streamCheckpoints({ startAfter: n })` means "yield the
 * tokens after n", and yielding nothing when `n >= TOTAL_TOKENS` is the coherent
 * answer, which is what the named test "startAfter beyond TOTAL_TOKENS yields no
 * text events and no checkpoints" pins. The route is the operator-input
 * boundary; that is where a clamp belongs.
 *
 * `TOTAL_TOKENS` is exactly the boundary, inclusive: resuming past the *last*
 * token is reachable from a clean run that dropped on the final token, and an
 * empty-but-complete stream is the right answer there.
 */
function parseCheckpointParam(raw: string): number {
  // A plain non-negative decimal integer literal and nothing else. Rejects the
  // whole prefix class (`1e5`, `13.9`, `5abc`), surrounding whitespace, signs,
  // and `0x`/`0b` forms — all of which fall through to 0, as they largely
  // already did.
  if (!/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  // `Number.isSafeInteger` rather than `isInteger`: a 20-digit literal parses to
  // a float that is an "integer" but no longer the value that was typed.
  if (!Number.isSafeInteger(n) || n > TOTAL_TOKENS) return 0;
  return n;
}

/**
 * GET /api/error-recovery?checkpoint=N
 *
 * Streams the prose body as SSE events:
 *   data: {"kind":"text","index":N,"text":"…"}          — per-chunk text
 *   data: {"kind":"checkpoint","last_token":N}         — every 5 tokens
 *   event: error\ndata: {"reason":"…","last_token":N}  — simulated drop
 *   event: done\ndata: {}                               — successful completion
 *
 * On the *first* request for a session (checkpoint=0) the server
 * simulates a mid-stream drop after DROP_AFTER_TOKENS text emissions
 * by closing the SSE stream with an `error` event. On any resume
 * request (checkpoint > 0) the server streams cleanly to completion.
 * This makes the recovery branch reproducible and observable in the
 * UI without needing a real flaky upstream.
 *
 * The simulated-drop `error` frame carries `last_token` = the exact
 * emission index at which the stream dropped; the client resumes from
 * THAT position (not the last recorded checkpoint, which lags the drop
 * by up to CHECKPOINT_EVERY-1 tokens) so no token is re-emitted. The
 * generic error frame (an unexpected failure) carries only `reason`.
 */
export async function GET(req: NextRequest): Promise<Response> {
  // Use `new URL(req.url)` rather than `req.nextUrl` so the route works
  // identically when called with a plain `Request` (the in-process test
  // shape) and when called via the Next.js routing layer.
  const url = new URL(req.url);
  const checkpointRaw = url.searchParams.get("checkpoint") ?? "0";
  const checkpoint = parseCheckpointParam(checkpointRaw);
  const dropOnce = checkpoint === 0; // resume requests never drop

  const encoder = new TextEncoder();

  // D-007: own the AbortController so the abort chain ends at the stream
  // source. Previously `streamCheckpoints` got no signal at all, so a client
  // disconnect (req.signal abort OR reader.cancel()) left the generator running
  // to completion. Wire both disconnect surfaces into `ac` and pass `ac.signal`.
  const ac = new AbortController();
  if (req.signal.aborted) {
    ac.abort();
  } else {
    req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: unknown, eventName?: string) => {
        const payload = JSON.stringify(data);
        const line = eventName
          ? `event: ${eventName}\ndata: ${payload}\n\n`
          : `data: ${payload}\n\n`;
        controller.enqueue(encoder.encode(line));
      };

      try {
        for await (const event of streamCheckpoints({
          startAfter: checkpoint,
          dropAfter: dropOnce ? DROP_AFTER_TOKENS : undefined,
          signal: ac.signal,
        })) {
          send(event);
        }
        send({}, "done");
      } catch (err) {
        if (err instanceof CheckpointStreamDropped) {
          send({ reason: err.message, last_token: err.emitted }, "error");
        } else {
          const message = err instanceof Error ? err.message : String(err);
          send({ reason: message }, "error");
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      // Browser disconnected (navigated away or hit Stop). Abort so
      // `streamCheckpoints` stops at the next event boundary — the for-await
      // loop does not break on its own.
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tell reverse proxies (nginx et al.) not to buffer the response. Without
      // it a proxy can accumulate the SSE bytes and flush them in one burst,
      // which for *this* route collapses the whole drop→resume demo into a
      // single late delivery — the incremental checkpoint/drop/resume sequence
      // is the entire point here. The three sibling SSE routes (stream-text,
      // tool-use, partial-json) all set this; error-recovery was the only one
      // missing it (#74). `no-transform` above governs content transformation,
      // not proxy buffering, so it is not a substitute.
      "X-Accel-Buffering": "no",
    },
  });
}
