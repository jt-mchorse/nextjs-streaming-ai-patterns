"use client";

import { useEffect, useRef, useState } from "react";

import { resumeTokenPosition } from "@/lib/checkpoint-stream";
import { pluralizeCount } from "@/lib/plural";
import { phaseOnFirstChunk, type RecoveryPhase } from "@/lib/recovery-phase";
import { isResumedPillVisible, resumedPillRemainingMs } from "@/lib/resume-pill";
import { parseSseFrame, pumpSseFramesToTerminal, sseJsonObject } from "@/lib/sse-stream";

type Phase = RecoveryPhase;

interface ResumeEvent {
  readonly at: number;
  readonly when: number; // perf-counter ms for the "resumed" badge timeout
}

/**
 * Reads /api/error-recovery as an SSE stream and automatically reconnects
 * if the stream closes with an `error` event. It resumes from the furthest
 * position it knows was delivered: the drop's `last_token` if the error
 * frame carries one, else the last `checkpoint` event or rendered token
 * (#58, #80). Checkpoints are the fallback, not the resume point.
 *
 * The recovery is visible to the user:
 * - A small "resumed at token N" pill renders for 2.5 s
 *   (`RESUMED_PILL_MS`) after each successful reconnect, and an effect
 *   clears it when that window closes (#152). "Successful" means the
 *   resumed request connected: the pill and the recovery count are set
 *   in `run` once it has an OK response with a body. They used to be set
 *   when the drop was detected, so a reconnect that then failed showed
 *   "fatal error · 1 recovery · resumed at token N" (#158).
 * - The accumulating text never resets on a drop — chunks before the
 *   drop stay rendered while the reconnect fires, then new chunks
 *   append in place.
 *
 * The route handler always drops the *first* request after
 * DROP_AFTER_TOKENS text events and always streams cleanly on any
 * resume request, so the recovery branch is reproducible — visitors
 * see the resumed pill on the first run, not by chance.
 */
export function ErrorRecoveryClient() {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [lastResume, setLastResume] = useState<ResumeEvent | null>(null);
  const [recoveryReason, setRecoveryReason] = useState<string | null>(null);
  const [recoveryCount, setRecoveryCount] = useState(0);
  const lastCheckpoint = useRef(0);
  // Furthest text-token index actually rendered. Checkpoints only advance
  // `lastCheckpoint` every CHECKPOINT_EVERY tokens, but text renders on every
  // event — so on a *raw* drop (no `error` frame) the checkpoint lags up to
  // CHECKPOINT_EVERY-1 tokens behind the screen. Resuming from the checkpoint
  // would replay those already-rendered tokens and append them a second time
  // (duplicated drop seam). Tracking the rendered index lets the raw-drop
  // branches resume from client-side truth, matching the #58 error-frame fix.
  const lastRendered = useRef(0);
  const aborted = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    aborted.current = false;
    void run(0, false);
    return () => {
      aborted.current = true;
      // Abort the in-flight (or most-recent resume) fetch on unmount. The
      // `aborted` flag alone only stops further setState/reconnect; the
      // AbortSignal passed to fetch never fired, so the HTTP connection
      // leaked until server EOF and the route's cancel() (D-007) never got
      // its disconnect. `run` reassigns controllerRef on every attempt, so
      // this always aborts the currently-live one.
      controllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(startAtCheckpoint: number, resumed: boolean): Promise<void> {
    // `resumed`, not `startAtCheckpoint > 0`: a drop before the first token
    // resumes from 0 and is still a resume.
    setPhase(resumed ? "recovering" : "streaming");
    const controller = new AbortController();
    controllerRef.current = controller;
    let resp: Response;
    try {
      resp = await fetch(
        `/api/error-recovery?checkpoint=${startAtCheckpoint}`,
        { signal: controller.signal },
      );
    } catch (err) {
      if (aborted.current) return;
      setPhase("fatal");
      setRecoveryReason(
        `connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (!resp.ok || !resp.body) {
      setPhase("fatal");
      setRecoveryReason(`HTTP ${resp.status}`);
      return;
    }

    // The reconnect succeeded, so this is the point to say so (#158). Not in
    // `scheduleResume`: that runs when the drop is detected, before the request
    // is even sent, and both failure branches above would leave the claim up.
    if (resumed) {
      setRecoveryCount((n) => n + 1);
      setLastResume({ at: startAtCheckpoint, when: Date.now() });
    }

    // Mark this run as "live"; clear the recovering banner once a chunk
    // arrives so the UI doesn't sit on "recovering" forever.
    let firstChunkSeen = false;

    const reader = resp.body.getReader();
    // Framing rules come from the shared framer (#106), read through the shared
    // pump (#220). This client used to run its own loop over the framer, and
    // `pumpSseFramesToTerminal` was written to the shape that loop was said to
    // have: stop on the terminal frame and cancel the reader (#196). The loop
    // only stopped; it never cancelled, so after `done` (or an `error` frame
    // that triggers a resume) the response body stayed open until the server
    // closed it. The pump's two ways to fail map onto the two drop reasons the
    // loop classified: a `reader.read()` that rejects before the terminal frame
    // propagates (a network drop), and a body that ends without one resolves
    // `false` (EOF mid-stream). Both reconnect.

    /**
     * Handle one complete frame; `true` means the run is over and the pump
     * must stop reading.
     *
     * The pump delivers the frames `push` returns and the frames its
     * end-of-stream flush returns through this one path (#114), so the
     * `done`/`error` branches below end the run wherever their frame lands.
     */
    function handleFrame(frame: string): boolean {
      if (frame.trim().length === 0) return false;
      const parsed = parseFrame(frame);
      if (!parsed) return false;
      if (parsed.event === "done") {
        setPhase("done");
        return true;
      }
      if (parsed.event === "error") {
        const data = parsed.data ?? {};
        setRecoveryReason(
          typeof data.reason === "string" ? data.reason : "unknown server-side error",
        );
        // Resume from the server-reported drop position, not the last
        // checkpoint. The drop can land past the last checkpoint (checkpoints
        // fire every CHECKPOINT_EVERY tokens; the drop is independent), and
        // those in-between tokens are already rendered — resuming from the
        // checkpoint would replay and duplicate them at the drop seam (#58).
        lastCheckpoint.current = resumeTokenPosition(
          lastCheckpoint.current,
          typeof data.last_token === "number" ? data.last_token : undefined,
        );
        scheduleResume();
        return true;
      }
      // Default — text or checkpoint event. `parseFrame` only returns a
      // non-terminal frame whose data is a JSON object (#193).
      if (parsed.data === null) return false;
      const ev = parsed.data as unknown as
        | { kind: "text"; index: number; text: string }
        | { kind: "checkpoint"; last_token: number };
      if (ev.kind === "text") {
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          // Functional updater so this reads the *live* phase, not `run`'s
          // stale render-0 closure (always "idle"). On a resume the live
          // phase is "recovering" and advances to "streaming" (#64).
          setPhase(phaseOnFirstChunk);
        }
        lastRendered.current = ev.index;
        setText((t) => t + ev.text);
      } else if (ev.kind === "checkpoint") {
        lastCheckpoint.current = ev.last_token;
      }
      return false;
    }

    let terminal: boolean;
    try {
      terminal = await pumpSseFramesToTerminal(reader, handleFrame);
    } catch (err) {
      if (aborted.current) return;
      // Network drop without an SSE error frame — reconnect.
      setRecoveryReason(
        `connection error: ${err instanceof Error ? err.message : String(err)}`,
      );
      scheduleResume();
      return;
    }
    if (terminal) return;
    // Stream ended without `done` or `error` event — treat as unexpected EOF
    // and reconnect. The pump has already flushed the decoder and the framer
    // (#114, #115, #198), so a terminal frame the body completed was delivered.
    setRecoveryReason("connection closed mid-stream");
    scheduleResume();
  }

  function scheduleResume(): void {
    if (aborted.current) return;
    // Resume from the furthest-forward position the client can prove it has
    // rendered. The error-frame branch already advanced `lastCheckpoint` to the
    // server-reported drop position (#58); the raw-drop branches did not, so
    // `lastRendered` (which never lags behind the screen) is what keeps them
    // from replaying and duplicating already-shown tokens at the seam.
    const checkpoint = Math.max(lastCheckpoint.current, lastRendered.current);
    // The drop is known now, so the phase says so for the back-off as well.
    // It used to stay "streaming", with the cursor blinking, until `run`
    // started the next fetch (#158). The pill and the count wait for that
    // fetch to connect; see `run`.
    setPhase("recovering");
    setTimeout(() => {
      if (!aborted.current) void run(checkpoint, true);
    }, 250); // tiny back-off before reconnecting
  }

  // Render alone cannot hide the pill: nothing re-renders when its window
  // closes, and the resumed stream is usually done well inside it (#152).
  // Schedule the clear; a newer resume replaces `lastResume`, and the cleanup
  // cancels the older timer, so each pill gets its own full window.
  useEffect(() => {
    if (lastResume === null) return;
    const shown = lastResume;
    const timer = setTimeout(
      () => setLastResume((current) => (current === shown ? null : current)),
      resumedPillRemainingMs(shown.when, Date.now()),
    );
    return () => clearTimeout(timer);
  }, [lastResume]);

  const showResumedPill =
    lastResume !== null && isResumedPillVisible(lastResume.when, Date.now());

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
        <PhaseDot phase={phase} />
        <span>
          {phase === "idle"
            ? "ready"
            : phase === "streaming"
              ? "streaming"
              : phase === "recovering"
                ? "recovering…"
                : phase === "done"
                  ? "done"
                  : "fatal error"}
        </span>
        {recoveryCount > 0 ? (
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide">
            {pluralizeCount(recoveryCount, "recovery", "recoveries")}
          </span>
        ) : null}
        {showResumedPill ? (
          <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--accent)]">
            resumed at token {lastResume!.at}
          </span>
        ) : null}
      </div>
      <div
        className="min-h-[8rem] whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel)] p-4 font-mono text-sm leading-relaxed"
        data-testid="error-recovery-output"
      >
        {text}
        {phase === "streaming" || phase === "recovering" ? (
          <span className="token-blink" />
        ) : null}
      </div>
      {recoveryReason && phase !== "done" ? (
        <div className="text-xs text-amber-400">
          last drop reason: {recoveryReason}
        </div>
      ) : null}
    </div>
  );
}

interface ParsedFrame {
  readonly event: string | null;
  /** The data as a JSON object; `null` only on a terminal frame (#193). */
  readonly data: Record<string, unknown> | null;
}

/**
 * A frame's event and its data as a JSON object, or `null` for a frame to skip.
 *
 * A terminal frame (`done`, `error`) is returned even when its data is empty,
 * not JSON, or JSON that is not an object, with `data: null`; the caller acts
 * on the event name (#193, the contract #191 set for the other clients). This
 * used to `JSON.parse` and cast: `data: null` parsed, then `data.reason` /
 * `ev.kind` threw out of `run()` -- started as `void run(...)`, so the page sat
 * on "streaming" forever with no reconnect -- and a non-JSON `error` frame was
 * dropped, so a later `done` showed a truncated answer as finished. Any other
 * frame whose data is not a JSON object is skipped.
 */
function parseFrame(frame: string): ParsedFrame | null {
  // This client keeps `null` rather than "message" as its no-event-line
  // default; that difference is load-bearing in the switch below, so it stays
  // at the call site while the parsing itself is shared (#93).
  const { event, data: dataLine } = parseSseFrame(frame);
  const data = sseJsonObject(dataLine);
  if (data === null && event !== "done" && event !== "error") return null;
  return { event, data };
}

function PhaseDot({ phase }: { phase: Phase }) {
  const color =
    phase === "streaming"
      ? "bg-[var(--accent)]"
      : phase === "recovering"
        ? "bg-amber-400"
        : phase === "fatal"
          ? "bg-red-500"
          : phase === "done"
            ? "bg-green-500"
            : "bg-[var(--border)]";
  return <span className={`inline-flex h-2 w-2 rounded-full ${color}`} />;
}
