"use client";

import { useCallback, useRef, useState } from "react";

import { parsePartialJson } from "@/lib/partial-json";

/**
 * Partial-JSON streaming UI (#3).
 *
 * Reads `/api/partial-json` as an SSE stream of `json_delta` events,
 * accumulates them into a buffer, and re-parses the whole buffer on
 * every chunk. The parser tolerates open strings, open arrays/objects,
 * trailing commas, and mid-token primitives — the UI just renders
 * whatever fields are currently parsable, with skeleton placeholders
 * for fields that haven't streamed in yet.
 *
 * Interrupt is end-to-end `AbortController` (D-007), same pattern as
 * the tool-use UI: click Interrupt → fetch's signal aborts → route
 * handler propagates to the streamer → final `message_stop` with
 * `stop_reason: "interrupted"` arrives so the transcript is clean.
 */

type Phase = "idle" | "connecting" | "streaming" | "done" | "interrupted" | "error";

interface TripItinerary {
  destination?: string;
  trip_length_days?: number;
  summary?: string;
  daily_plan?: DailyPlanEntry[];
  budget_estimate_usd?: number;
}

interface DailyPlanEntry {
  day?: number;
  morning?: string;
  afternoon?: string;
  evening?: string;
}

export function PartialJsonClient(): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("idle");
  const [parsed, setParsed] = useState<TripItinerary | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [bufferLen, setBufferLen] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (phase === "connecting" || phase === "streaming") return;
    setParsed(null);
    setIsComplete(false);
    setBufferLen(0);
    setError(null);
    setPhase("connecting");

    const ctrl = new AbortController();
    controllerRef.current = ctrl;
    let resp: Response;
    try {
      resp = await fetch("/api/partial-json", { signal: ctrl.signal });
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") {
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
    const decoder = new TextDecoder();
    let frameBuf = "";
    let jsonBuf = "";

    setPhase("streaming");

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      frameBuf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = frameBuf.indexOf("\n\n")) !== -1) {
        const frame = frameBuf.slice(0, idx);
        frameBuf = frameBuf.slice(idx + 2);
        handleFrame(frame);
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
        case "json_delta": {
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          jsonBuf += delta;
          const r = parsePartialJson<TripItinerary>(jsonBuf);
          setParsed(r.value);
          setIsComplete(r.isComplete);
          setBufferLen(jsonBuf.length);
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
  }, [phase]);

  const interrupt = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const inFlight = phase === "connecting" || phase === "streaming";

  return (
    <section className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={inFlight}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {inFlight ? "Streaming…" : "Plan a trip"}
        </button>
        <button
          type="button"
          onClick={interrupt}
          disabled={!inFlight}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Interrupt
        </button>
        <span className="ml-auto text-xs text-[var(--muted)]">
          phase: <code>{phase}</code>
          {bufferLen > 0 ? (
            <>
              {" "}
              · buffer: <code>{bufferLen} chars</code>
              {" · "}
              <code>{isComplete ? "complete" : "partial"}</code>
            </>
          ) : null}
        </span>
      </div>

      {error ? <p className="text-sm text-red-500">{error}</p> : null}

      <Itinerary value={parsed} isComplete={isComplete} />
    </section>
  );
}

function Itinerary({
  value,
  isComplete,
}: {
  value: TripItinerary | null;
  isComplete: boolean;
}): React.ReactElement {
  const dest = value?.destination;
  const days = value?.trip_length_days;
  const summary = value?.summary;
  const plan = value?.daily_plan ?? [];
  const budget = value?.budget_estimate_usd;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h3 className="text-lg font-medium tracking-tight">
          {dest ?? <Skeleton width="12rem" />}
        </h3>
        <p className="text-xs text-[var(--muted)]">
          {typeof days === "number" ? (
            <>
              {days} day{days === 1 ? "" : "s"}
            </>
          ) : (
            <Skeleton width="4rem" />
          )}
          {" · "}
          {typeof budget === "number" ? (
            <>~${budget} budget</>
          ) : (
            <Skeleton width="6rem" />
          )}
        </p>
      </header>

      <p className="text-sm text-[var(--muted)]">
        {summary ?? <Skeleton width="100%" />}
      </p>

      <ol className="space-y-3">
        {(plan.length > 0 ? plan : [{}, {}, {}]).map((entry, idx) => (
          <li
            key={idx}
            className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3"
          >
            <div className="text-xs uppercase tracking-wide text-[var(--muted)]">
              Day {entry.day ?? idx + 1}
            </div>
            <div className="mt-1 grid gap-1 text-sm">
              <Field label="Morning" value={entry.morning} />
              <Field label="Afternoon" value={entry.afternoon} />
              <Field label="Evening" value={entry.evening} />
            </div>
          </li>
        ))}
      </ol>

      {!isComplete ? (
        <p className="text-xs text-[var(--muted)]">
          Rendering best-effort partial parse — fields above will replace
          their skeletons as the stream completes them.
        </p>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | undefined }): React.ReactElement {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2">
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <span className="text-sm">
        {value ?? <Skeleton width="80%" />}
      </span>
    </div>
  );
}

function Skeleton({ width }: { width: string }): React.ReactElement {
  return (
    <span
      aria-hidden
      className="inline-block h-3 animate-pulse rounded bg-[var(--border)]"
      style={{ width }}
    />
  );
}
