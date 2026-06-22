import { NextRequest } from "next/server";

import { mockJsonStream } from "@/lib/mock-json-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Partial-JSON SSE endpoint (#3).
 *
 * Streams the mock JSON payload as a sequence of `json_delta` events
 * terminated by `message_stop`. The same SSE envelope shape every
 * other pattern in this repo uses (D-006), so the client renderer
 * stays consistent.
 *
 * `req.signal` propagation is D-007: client's `AbortController.abort()`
 * closes the upstream connection, Next.js forwards it on `req.signal`,
 * the streamer yields a final `message_stop` with
 * `stop_reason: "interrupted"`, and the route closes cleanly.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const encoder = new TextEncoder();

  // D-007: own the AbortController so the abort chain ends at the stream
  // source. A disconnect can surface either as `req.signal` aborting OR as the
  // ReadableStream being cancelled (the for-await loop is NOT auto-cancelled on
  // cancel()); wire both into `ac` and pass `ac.signal` to the streamer.
  // Previously only `req.signal` was forwarded, so a `reader.cancel()` (the
  // Stop-button path) left the stream pulling to completion.
  const ac = new AbortController();
  if (req.signal.aborted) {
    ac.abort();
  } else {
    req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of mockJsonStream({ signal: ac.signal })) {
          const { type, ...rest } = event;
          const data = JSON.stringify(rest);
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${data}\n\n`));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
    cancel() {
      // Browser disconnected (navigated away or hit Stop). Abort so the
      // streamer stops pulling — the for-await loop does not break on its own.
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
