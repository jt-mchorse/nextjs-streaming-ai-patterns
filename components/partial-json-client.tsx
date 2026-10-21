"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { parsePartialJson } from "@/lib/partial-json";
import { pluralizeCount } from "@/lib/plural";
import {
  isAbortError,
  parseSseFrame,
  pumpSseFramesToTerminal,
  sseJsonObject,
  STREAM_ENDED_WITHOUT_TERMINAL,
} from "@/lib/sse-stream";

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
 * handler propagates to the streamer, which stops at its next chunk
 * boundary. No `message_stop: interrupted` frame reaches this component;
 * it aborted its own fetch, so it lands on `interrupted` by classifying
 * that `AbortError` (#208).
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
    let jsonBuf = "";

    setPhase("streaming");

    try {
      // A clean end with no `message_stop`/`error` frame left the phase
      // non-terminal for good -- Run disabled, Interrupt inert (#138).
      if (!(await pumpSseFramesToTerminal(reader, handleFrame))) {
        setError(STREAM_ENDED_WITHOUT_TERMINAL);
        setPhase("error");
      }
    } catch (e) {
      // Interrupt aborts the in-flight read; that's the `interrupted` terminal
      // state, not an error. Without this the AbortError escaped run() and the
      // UI wedged in the non-terminal `streaming` phase (#60).
      if (isAbortError(e)) {
        setPhase("interrupted");
      } else {
        setError((e as Error).message);
        setPhase("error");
      }
    }

    // Returns true when the frame put the client in a terminal phase (#138).
    function handleFrame(frame: string): boolean {
      // `?? "message"` keeps this client's existing default event name; the
      // shared parser reports a missing `event:` line as null (#93).
      const { event, data: dataLine } = parseSseFrame(frame);
      const eventName = event ?? "message";
      // A terminal frame acts on its event even when its data is unreadable;
      // its fields then fall back below (#191). Any other such frame is skipped.
      const terminal = eventName === "error" || eventName === "message_stop";
      const parsed = sseJsonObject(dataLine);
      if (parsed === null && !terminal) return false;
      const payload: Record<string, unknown> = parsed ?? {};
      switch (eventName) {
        case "json_delta": {
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          jsonBuf += delta;
          const r = parsePartialJson<TripItinerary>(jsonBuf);
          setParsed(r.value);
          setIsComplete(r.isComplete);
          setBufferLen(jsonBuf.length);
          return false;
        }
        case "message_stop": {
          const reason = String(payload.stop_reason ?? "end_turn");
          setPhase(reason === "interrupted" ? "interrupted" : "done");
          return true;
        }
        case "error": {
          setError(typeof payload.error === "string" ? payload.error : "unknown error");
          setPhase("error");
          return true;
        }
      }
      return false;
    }
  }, [phase]);

  const interrupt = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  // Tear down the controller on unmount so navigating away mid-stream aborts
  // the in-flight fetch/reader instead of leaving it open until server EOF.
  // A browser fetch is NOT auto-aborted when its initiating component unmounts,
  // so without this the route's abort-on-disconnect chain (D-007) never fires.
  // Mirrors tool-use-client.tsx.
  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const inFlight = phase === "connecting" || phase === "streaming";
  // A run that has ended will not fill any more fields, so the itinerary must
  // stop promising that it will: no pulsing skeletons, no "will replace" copy
  // (#205). `idle` is not terminal -- nothing has been asked for yet.
  const terminal = phase === "done" || phase === "interrupted" || phase === "error";

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

      <Itinerary value={parsed} isComplete={isComplete} terminal={terminal} />
    </section>
  );
}

function Itinerary({
  value,
  isComplete,
  terminal,
}: {
  value: TripItinerary | null;
  isComplete: boolean;
  /** The run has ended; unfilled fields will never arrive (#205). */
  terminal: boolean;
}): React.ReactElement {
  // Unfilled slot: pulsing while the stream may still fill it, static once the
  // run is over (#205).
  const missing = (width: string) =>
    terminal ? <NotReceived /> : <Skeleton width={width} />;

  const dest = value?.destination;
  const days = value?.trip_length_days;
  const summary = value?.summary;
  const plan = value?.daily_plan ?? [];
  const budget = value?.budget_estimate_usd;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h3 className="text-lg font-medium tracking-tight">
          {dest ?? missing("12rem")}
        </h3>
        <p className="text-xs text-[var(--muted)]">
          {typeof days === "number" ? (
            <>{pluralizeCount(days, "day")}</>
          ) : (
            missing("4rem")
          )}
          {" · "}
          {typeof budget === "number" ? (
            <>~${budget} budget</>
          ) : (
            missing("6rem")
          )}
        </p>
      </header>

      <p className="text-sm text-[var(--muted)]">
        {summary ?? missing("100%")}
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
              <Field label="Morning" value={entry.morning} terminal={terminal} />
              <Field label="Afternoon" value={entry.afternoon} terminal={terminal} />
              <Field label="Evening" value={entry.evening} terminal={terminal} />
            </div>
          </li>
        ))}
      </ol>

      {!isComplete ? (
        <p className="text-xs text-[var(--muted)]">
          {terminal
            ? "Stream ended before the JSON completed — fields marked “not received” never arrived."
            : "Rendering best-effort partial parse — fields above will replace their skeletons as the stream completes them."}
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  terminal,
}: {
  label: string;
  value: string | undefined;
  terminal: boolean;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2">
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <span className="text-sm">
        {value ?? (terminal ? <NotReceived /> : <Skeleton width="80%" />)}
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

/** Static stand-in for a field the ended run never sent (#205). */
function NotReceived(): React.ReactElement {
  return <span className="text-xs italic text-[var(--muted)]">not received</span>;
}
