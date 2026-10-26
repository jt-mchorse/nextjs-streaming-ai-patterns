"use client";

import { useEffect, useState } from "react";

import {
  createSseFramer,
  parseSseFrame,
  STREAM_TEXT_ENDED_WITHOUT_DONE,
} from "@/lib/sse-stream";

interface StreamingTextClientProps {
  prompt: string;
}

type Status = "idle" | "streaming" | "done" | "error";

/**
 * Reads /api/stream-text as an SSE stream and progressively renders text.
 *
 * This is the client side of the streaming text pattern. The server side
 * lives in app/api/stream-text/route.ts; together they form a HTTP-streaming
 * loop with no WebSockets.
 *
 * Why a client component for the rendering? Because true per-token rendering
 * in the browser requires *client-side* re-renders as each chunk arrives.
 * The Server Component does the *server-side* streaming (the route handler
 * yields tokens into the HTTP response body); the Client Component does the
 * *browser-side* incremental rendering. Both are required for the end-to-end
 * pattern.
 */
export function StreamingTextClient({ prompt }: StreamingTextClientProps) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    // The route always ends with `event: done`; a body that ends without it was
    // cut short (#142).
    let sawDone = false;
    // An `event: error` frame's message. Recorded rather than thrown from the
    // frame handler, so the loop ends the same way it does on `done` and
    // cancels the reader; thrown after the loop (#226).
    let errorFrame: string | null = null;

    (async () => {
      setStatus("streaming");
      setText("");
      setErrorMessage(null);

      try {
        const response = await fetch(
          `/api/stream-text?prompt=${encodeURIComponent(prompt)}`,
          { signal: controller.signal },
        );
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        // The wire-format rules live in `createSseFramer`, not here. This loop
        // used to scan for `"\n\n"` itself, which is the pre-#95 shape: the SSE
        // spec ends a line with any of `\r\n`, `\n`, or `\r`, so a CRLF- or
        // CR-framed body contains no adjacent `\n\n` and this component
        // discarded the ENTIRE stream — 0 frames, no throw, then `setStatus
        // ("done")` on an empty pane. #95 fixed that in `pumpSseFrames`, which
        // this component does not use, so the fix never reached it (#106).
        //
        // The read loop stays local because it has something to say: the
        // `cancelled` check between reads. Only the framing is shared.
        const framer = createSseFramer();

        // `event: done` ends the run: stop handling frames AND stop reading
        // (#196). This loop used to note `sawDone` and carry on, so a text
        // frame after `done` was still rendered, an `error` frame after it
        // threw, and a connection error on the next read -- undici's
        // "terminated" -- reached the catch below. Each turned a finished
        // answer into a different one or into an error. `error-recovery-client`
        // already returned on `done`; #191 did the same for the pump clients.
        //
        // `event: error` is terminal too, and ends the loop the same way. It
        // used to throw out of `handleFrame`, which jumped past the cancel
        // below, so the connection stayed open until the server closed it
        // (#226, the shape #220 fixed in `error-recovery-client`).
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (cancelled) return;
          // Within a frame, we only care about `data:` and `event:` lines.
          if (handleFrames(framer.push(decoder.decode(value, { stream: true })))) {
            // Release the connection; a late rejection here is dropped, the
            // run is already over.
            reader.cancel().catch(() => {});
            break;
          }
        }
        if (cancelled) return;
        // Decoder before framer (#115, D-013) — see `pumpSseFrames`. All three
        // SSE read paths carry this in the same order; the lock in
        // `test/sse-framing-parity.test.ts` is what keeps the third one from
        // being forgotten, which is the shape #114 was. Skipped once `done`
        // was seen: nothing after it counts (#196).
        if (!sawDone && errorFrame === null && !handleFrames(framer.push(decoder.decode()))) {
          handleFrames(framer.flush());
        }
        if (errorFrame !== null) throw new Error(errorFrame);
        // A proxy timeout, a server crash mid-stream or an empty 200 body all
        // end the read cleanly. This used to set `done` regardless, so a cut
        // stream rendered as a finished answer -- the cursor gone, no error
        // (#142). The same rule #138 gave the two `pumpSseFrames` clients.
        if (!sawDone) throw new Error(STREAM_TEXT_ENDED_WITHOUT_DONE);
        setStatus("done");
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setErrorMessage(message);
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };

    /** Handle frames in order; `true` once `event: done` or `event: error`
     *  is seen, after which the rest are not handled (#196, #226). */
    function handleFrames(frames: readonly string[]): boolean {
      for (const frame of frames) {
        handleFrame(frame);
        if (sawDone || errorFrame !== null) return true;
      }
      return false;
    }

    function handleFrame(frame: string): void {
      // This copy was already the most spec-correct of the four (optional
      // space, trimmed value); the shared parser preserves that behaviour and
      // adds accumulate-and-ignore-comments (#93).
      const { event, data } = parseSseFrame(frame);
      const eventName = event ?? "message";
      if (eventName === "done") {
        sawDone = true;
        return;
      }
      if (eventName === "error") {
        errorFrame = errorFrameMessage(data);
        return;
      }
      if (!data) return;
      try {
        const parsed = JSON.parse(data) as { text?: string };
        if (typeof parsed.text === "string") {
          setText((prev) => prev + parsed.text);
        }
      } catch {
        // Unparseable frame — skip. Don't tear the whole stream down.
      }
    }
  }, [prompt]);

  // An error keeps the text that already streamed, with the error line below
  // it (#218). This used to render one or the other, so a run that ended in
  // error after tokens -- every live answer cut at `max_tokens` since #167 --
  // replaced the words the user had watched arrive with a message that says
  // "the text above may be incomplete". The other SSE clients already keep
  // their content on error. Nothing streamed: just the error, as before.
  const failed = status === "error" && Boolean(errorMessage);
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6 text-base leading-relaxed">
      {(!failed || text !== "") && (
        <p className="whitespace-pre-wrap text-[var(--foreground)]">
          {text}
          {status !== "done" && !failed && <span className="token-blink" />}
        </p>
      )}
      {failed && (
        <p className={`text-red-400${text !== "" ? " mt-3" : ""}`}>stream error: {errorMessage}</p>
      )}
    </div>
  );
}

/**
 * The message an `event: error` frame carries, or `"stream error"` (#189).
 *
 * The route sends `{"error": "<message>"}`. Anything else -- an empty or
 * non-JSON payload, `null`, a non-string `error` -- gets the fallback, which is
 * `partial-json-client`'s rule for the same frame. The previous try/rethrow
 * rethrew `JSON.parse`'s `SyntaxError` (it is an `Error`), so the fallback was
 * unreachable and the user read "Unexpected end of JSON input".
 */
function errorFrameMessage(data: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return "stream error";
  }
  if (parsed !== null && typeof parsed === "object") {
    const message = (parsed as { error?: unknown }).error;
    if (typeof message === "string" && message !== "") return message;
  }
  return "stream error";
}
