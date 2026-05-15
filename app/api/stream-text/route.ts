import { NextRequest } from "next/server";

import { streamText } from "@/lib/anthropic-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events endpoint that streams text deltas as they arrive from the
 * model (or the mock streamer). Each event is `data: <json>\n\n` per the SSE
 * wire format; the final event is `event: done\ndata: {}\n\n`.
 *
 * The client component in `app/streaming-text/page.tsx` reads this via the
 * Fetch API's ReadableStream and appends each delta to its local state. No
 * WebSocket, no polling — the connection is one HTTP/2 stream from start to
 * finish.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const prompt =
    req.nextUrl.searchParams.get("prompt") ??
    "Write a short paragraph about why streaming output beats waiting for the whole message.";

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of streamText(prompt)) {
          const payload = JSON.stringify({ text: chunk.text });
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const payload = JSON.stringify({ error: message });
        controller.enqueue(encoder.encode(`event: error\ndata: ${payload}\n\n`));
      } finally {
        controller.close();
      }
    },
    cancel() {
      // The browser disconnected (user navigated away or hit Cancel). Generator
      // cancellation cascades back to `streamText` via the for-await break.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
