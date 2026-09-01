"use client";

import { useEffect, useState } from "react";

import { createSseFramer, parseSseFrame } from "@/lib/sse-stream";

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

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (cancelled) return;
          // Within a frame, we only care about `data:` and `event:` lines.
          for (const frame of framer.push(
            decoder.decode(value, { stream: true }),
          )) {
            handleFrame(frame);
          }
        }
        if (cancelled) return;
        // Decoder before framer (#115, D-013) — see `pumpSseFrames`. All three
        // SSE read paths carry this in the same order; the lock in
        // `test/sse-framing-parity.test.ts` is what keeps the third one from
        // being forgotten, which is the shape #114 was.
        for (const frame of framer.push(decoder.decode())) handleFrame(frame);
        for (const frame of framer.flush()) handleFrame(frame);
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

    function handleFrame(frame: string): void {
      // This copy was already the most spec-correct of the four (optional
      // space, trimmed value); the shared parser preserves that behaviour and
      // adds accumulate-and-ignore-comments (#93).
      const { event, data } = parseSseFrame(frame);
      const eventName = event ?? "message";
      if (eventName === "done") {
        return;
      }
      if (eventName === "error") {
        try {
          const parsed = JSON.parse(data) as { error?: string };
          throw new Error(parsed.error ?? "stream error");
        } catch (e) {
          if (e instanceof Error) throw e;
          throw new Error("stream error");
        }
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

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6 text-base leading-relaxed">
      {status === "error" && errorMessage ? (
        <p className="text-red-400">stream error: {errorMessage}</p>
      ) : (
        <p className="whitespace-pre-wrap text-[var(--foreground)]">
          {text}
          {status !== "done" && <span className="token-blink" />}
        </p>
      )}
    </div>
  );
}
