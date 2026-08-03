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
  // Use `new URL(req.url)` rather than `req.nextUrl` so the route works
  // identically when called with a plain `Request` (the in-process test shape)
  // and when called via the Next.js routing layer. `nextUrl` is a `NextRequest`
  // extension and is `undefined` on a plain `Request`, so the property access
  // threw an opaque `TypeError: Cannot read properties of undefined (reading
  // 'searchParams')` before the handler did anything (#91). `error-recovery`
  // has read its query param this way since #58; this was the last route that
  // hadn't — see `test/api-routes-accept-plain-request.test.ts` for the lock.
  const url = new URL(req.url);
  const prompt =
    url.searchParams.get("prompt") ??
    "Write a short paragraph about why streaming output beats waiting for the whole message.";

  const encoder = new TextEncoder();

  // D-007: the abort chain ends at the stream source. We own an AbortController
  // here, pass its signal into `streamText`, and abort it when the client goes
  // away. A ReadableStream's `start` loop is NOT auto-cancelled when the stream
  // is cancelled, so without this the live SDK stream would keep running (and
  // keep being billed) after a disconnect.
  const ac = new AbortController();
  // A disconnect can surface either as the request signal aborting or as the
  // ReadableStream being cancelled; wire both into our controller.
  if (req.signal.aborted) {
    ac.abort();
  } else {
    req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of streamText(prompt, { signal: ac.signal })) {
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
      // The browser disconnected (navigated away or hit Cancel). Abort the
      // controller so `streamText` stops pulling from the model and the live
      // SDK request is torn down — the for-await loop does not break on its own.
      ac.abort();
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
