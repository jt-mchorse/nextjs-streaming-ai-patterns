import { NextRequest } from "next/server";

import {
  CheckpointStreamDropped,
  streamCheckpoints,
} from "@/lib/checkpoint-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DROP_AFTER_TOKENS = 12;

/**
 * GET /api/error-recovery?checkpoint=N&session=S
 *
 * Streams the prose body as SSE events:
 *   data: {"kind":"text","index":N,"text":"…"}      — per-chunk text
 *   data: {"kind":"checkpoint","last_token":N}     — every 5 tokens
 *   event: error\ndata: {"reason":"…"}              — simulated drop
 *   event: done\ndata: {}                           — successful completion
 *
 * On the *first* request for a session (checkpoint=0) the server
 * simulates a mid-stream drop after DROP_AFTER_TOKENS text emissions
 * by closing the SSE stream with an `error` event. On any resume
 * request (checkpoint > 0) the server streams cleanly to completion.
 * This makes the recovery branch reproducible and observable in the
 * UI without needing a real flaky upstream.
 */
export async function GET(req: NextRequest): Promise<Response> {
  // Use `new URL(req.url)` rather than `req.nextUrl` so the route works
  // identically when called with a plain `Request` (the in-process test
  // shape) and when called via the Next.js routing layer.
  const url = new URL(req.url);
  const checkpointRaw = url.searchParams.get("checkpoint") ?? "0";
  const checkpointNum = Number.parseInt(checkpointRaw, 10);
  const checkpoint = Number.isInteger(checkpointNum) && checkpointNum >= 0 ? checkpointNum : 0;
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
    },
  });
}
