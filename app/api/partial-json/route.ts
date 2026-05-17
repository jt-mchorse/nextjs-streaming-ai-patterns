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
  const signal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of mockJsonStream({ signal })) {
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
