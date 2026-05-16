import { NextRequest } from "next/server";

import { mockToolStream } from "@/lib/mock-tool-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tool-use SSE endpoint.
 *
 * Streams the same frame shape `mockToolStream` produces:
 *
 *   event: text_delta        data: { "text": "..." }
 *   event: tool_use_start    data: { "tool_use_id": "...", "tool_name": "..." }
 *   event: tool_use_delta    data: { "partial_json": "..." }
 *   event: tool_use_stop     data: {}
 *   event: tool_result       data: { "tool_use_id": "...", "result": ... }
 *   event: message_stop      data: { "stop_reason": "end_turn" | "interrupted" }
 *   event: error             data: { "error": "..." }   // any thrown exception
 *
 * Why one SSE shape for both text-only (#1) and tool-use (#2): the
 * client renderer can union over the `event:` types and dispatch in
 * one place. New patterns just add new event names — D-006 codifies
 * this protocol decision.
 *
 * The `req.signal` propagation is the interrupt mechanism (D-007):
 * the client's `AbortController.abort()` closes the upstream connection,
 * Next.js surfaces that on `req.signal`, and we pass it to the
 * streamer which yields a final `message_stop` with
 * `stop_reason: "interrupted"` before returning. Clean transcript;
 * no broken-pipe errors visible to the user.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const encoder = new TextEncoder();
  const signal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of mockToolStream({ signal })) {
          const data = JSON.stringify(eventPayload(event));
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${data}\n\n`));
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

// Strip the discriminator (already in `event:`) so the data line carries
// only the payload, matching Anthropic SDK's wire shape.
function eventPayload(event: { type: string } & Record<string, unknown>): Record<string, unknown> {
  const { type: _type, ...rest } = event;
  void _type;
  return rest;
}
