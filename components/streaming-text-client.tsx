"use client";

import { useEffect, useState } from "react";

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
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (cancelled) return;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE event-frames as they accumulate. Frames are separated by
          // a blank line (\n\n); within a frame, we only care about `data:`
          // and `event:` lines.
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            handleFrame(frame);
          }
        }
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
      let eventName = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          data += line.slice("data:".length).trimStart();
        }
      }
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
