"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { isAbortError, pumpSseFrames } from "@/lib/sse-stream";

/**
 * Tool-use streaming UI (#2).
 *
 * Reads `/api/tool-use` as an SSE stream of typed events and renders a
 * step-by-step timeline. The interrupt button calls
 * `AbortController.abort()` end-to-end (D-007) — the route handler
 * propagates the abort to the streamer, which yields a clean
 * `message_stop` with `stop_reason: "interrupted"` before closing.
 *
 * The component is a small state machine (doc:
 * `docs/tool-use-state-machine.md`). Transitions:
 *
 *   idle             → connecting              (user clicks Run)
 *   connecting       → streaming_text          (first text_delta or tool_use_start)
 *   streaming_text   → tool_called             (tool_use_start)
 *   tool_called      → tool_running            (tool_use_stop)
 *   tool_running     → tool_completed          (tool_result)
 *   tool_completed   → streaming_text          (any subsequent text_delta)
 *   streaming_text   → done                    (message_stop end_turn)
 *   *                → interrupted             (message_stop interrupted | abort)
 *   *                → error                   (event:error)
 */

type Phase =
  | "idle"
  | "connecting"
  | "streaming_text"
  | "tool_called"
  | "tool_running"
  | "tool_completed"
  | "done"
  | "interrupted"
  | "error";

interface TimelineText {
  kind: "text";
  /** "before" if before the tool call, "after" if after. */
  position: "before" | "after";
  text: string;
}

interface TimelineToolCall {
  kind: "tool_call";
  tool_use_id: string;
  tool_name: string;
  /** Streaming-in JSON args. */
  partial_args: string;
  /** Parsed args once the tool_use_stop event arrives; null until then. */
  parsed_args: unknown | null;
  /** Tool execution result; null until the tool_result event arrives. */
  result: unknown | null;
  /** Whether the tool_use_stop event has arrived (parsing is "complete"). */
  args_complete: boolean;
}

type TimelineNode = TimelineText | TimelineToolCall;

export function ToolUseClient() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [timeline, setTimeline] = useState<TimelineNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // Helper: replace the latest text node (or push a new one) to
  // accumulate streaming tokens.
  const appendText = useCallback((delta: string, position: "before" | "after") => {
    setTimeline((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "text" && last.position === position) {
        return [
          ...prev.slice(0, -1),
          { kind: "text", position, text: last.text + delta },
        ];
      }
      return [...prev, { kind: "text", position, text: delta }];
    });
  }, []);

  // Helper: update the in-flight tool call card.
  const updateTool = useCallback(
    (id: string, fn: (t: TimelineToolCall) => TimelineToolCall) => {
      setTimeline((prev) =>
        prev.map((n) => (n.kind === "tool_call" && n.tool_use_id === id ? fn(n) : n)),
      );
    },
    [],
  );

  const run = useCallback(async () => {
    if (phase !== "idle" && phase !== "done" && phase !== "interrupted" && phase !== "error") {
      return; // already in-flight
    }
    setTimeline([]);
    setError(null);
    setPhase("connecting");

    const ctrl = new AbortController();
    controllerRef.current = ctrl;
    let resp: Response;
    try {
      resp = await fetch("/api/tool-use", { signal: ctrl.signal });
    } catch (e) {
      if (isAbortError(e)) {
        setPhase("interrupted");
      } else {
        setError((e as Error).message);
        setPhase("error");
      }
      return;
    }
    if (!resp.ok || !resp.body) {
      setError(`HTTP ${resp.status}`);
      setPhase("error");
      return;
    }

    const reader = resp.body.getReader();
    let currentToolId: string | null = null;
    let phasePosition: "before" | "after" = "before";

    try {
      await pumpSseFrames(reader, handleFrame);
    } catch (e) {
      // Interrupt aborts the in-flight read; per docs/tool-use-state-machine.md
      // that's the `interrupted` terminal state, not an error. Without this the
      // AbortError escaped run() and the UI wedged in a non-terminal phase (#60).
      if (isAbortError(e)) {
        setPhase("interrupted");
      } else {
        setError((e as Error).message);
        setPhase("error");
      }
    }

    function handleFrame(frame: string): void {
      let eventName = "message";
      let dataLine = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) eventName = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLine += line.slice(6);
      }
      if (!dataLine) return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(dataLine) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (eventName) {
        case "text_delta": {
          const t = typeof payload.text === "string" ? payload.text : "";
          appendText(t, phasePosition);
          setPhase((p) => (p === "tool_completed" || p === "tool_called" || p === "tool_running" ? "streaming_text" : "streaming_text"));
          return;
        }
        case "tool_use_start": {
          const id = String(payload.tool_use_id ?? "");
          const name = String(payload.tool_name ?? "unknown_tool");
          currentToolId = id;
          phasePosition = "before";
          setTimeline((prev) => [
            ...prev,
            {
              kind: "tool_call",
              tool_use_id: id,
              tool_name: name,
              partial_args: "",
              parsed_args: null,
              result: null,
              args_complete: false,
            },
          ]);
          setPhase("tool_called");
          return;
        }
        case "tool_use_delta": {
          const chunk = typeof payload.partial_json === "string" ? payload.partial_json : "";
          if (currentToolId) {
            updateTool(currentToolId, (t) => ({ ...t, partial_args: t.partial_args + chunk }));
          }
          return;
        }
        case "tool_use_stop": {
          if (currentToolId) {
            updateTool(currentToolId, (t) => {
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(t.partial_args);
              } catch {
                parsed = null;
              }
              return { ...t, parsed_args: parsed, args_complete: true };
            });
          }
          setPhase("tool_running");
          return;
        }
        case "tool_result": {
          const id = String(payload.tool_use_id ?? "");
          updateTool(id, (t) => ({ ...t, result: payload.result }));
          phasePosition = "after";
          setPhase("tool_completed");
          return;
        }
        case "message_stop": {
          const reason = String(payload.stop_reason ?? "end_turn");
          setPhase(reason === "interrupted" ? "interrupted" : "done");
          return;
        }
        case "error": {
          setError(typeof payload.error === "string" ? payload.error : "unknown error");
          setPhase("error");
          return;
        }
      }
    }
  }, [phase, appendText, updateTool]);

  const interrupt = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  // Tear down the controller on unmount so component-leave doesn't leave a
  // dangling stream open.
  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const isStreaming =
    phase === "connecting" ||
    phase === "streaming_text" ||
    phase === "tool_called" ||
    phase === "tool_running" ||
    phase === "tool_completed";

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={run}
          disabled={isStreaming}
          data-testid="run-button"
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {isStreaming ? "running…" : "Run"}
        </button>
        <button
          onClick={interrupt}
          disabled={!isStreaming}
          data-testid="interrupt-button"
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--fg)] disabled:opacity-50"
        >
          Interrupt
        </button>
        <span className="text-xs text-[var(--muted)]" data-testid="phase">
          phase: <code>{phase}</code>
        </span>
      </div>

      {error ? (
        <div
          className="rounded-md border border-[var(--err)] bg-[var(--err-bg)] p-3 text-sm text-[var(--err)]"
          data-testid="error-banner"
        >
          {error}
        </div>
      ) : null}

      <div className="space-y-3" data-testid="timeline">
        {timeline.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No events yet — click Run.</p>
        ) : null}
        {timeline.map((node, i) =>
          node.kind === "text" ? (
            <div
              key={i}
              className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3 text-sm leading-relaxed"
              data-testid={`text-card-${node.position}`}
            >
              {node.text}
            </div>
          ) : (
            <ToolCard key={i} node={node} />
          ),
        )}
      </div>
    </section>
  );
}

function ToolCard({ node }: { node: TimelineToolCall }) {
  return (
    <div
      className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent-bg)] p-3 text-sm"
      data-testid={`tool-card-${node.tool_use_id}`}
    >
      <div className="font-mono text-xs text-[var(--accent)]">
        tool_call · <code>{node.tool_name}</code>
      </div>
      <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-snug">
        {node.args_complete
          ? JSON.stringify(node.parsed_args, null, 2)
          : node.partial_args + (node.args_complete ? "" : "▍")}
      </pre>
      {node.result !== null ? (
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <div className="font-mono text-xs text-[var(--muted)]">result</div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-snug">
            {JSON.stringify(node.result, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
