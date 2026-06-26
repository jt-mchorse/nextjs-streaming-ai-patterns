"use client";

import { useEffect, useRef, useState } from "react";

import { resumeTokenPosition } from "@/lib/checkpoint-stream";

type Phase = "idle" | "streaming" | "recovering" | "done" | "fatal";

interface ResumeEvent {
  readonly at: number;
  readonly when: number; // perf-counter ms for the "resumed" badge timeout
}

/**
 * Reads /api/error-recovery as an SSE stream, accumulates `checkpoint`
 * events as the most-recent resume point, and automatically reconnects
 * if the stream closes with an `error` event.
 *
 * The recovery is visible to the user:
 * - A small "resumed at token N" pill renders for 2s after each
 *   successful reconnect.
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
  const aborted = useRef(false);

  useEffect(() => {
    aborted.current = false;
    void run(0);
    return () => {
      aborted.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(startAtCheckpoint: number): Promise<void> {
    setPhase(startAtCheckpoint === 0 ? "streaming" : "recovering");
    const controller = new AbortController();
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

    // Mark this run as "live"; clear the recovering banner once a chunk
    // arrives so the UI doesn't sit on "recovering" forever.
    let firstChunkSeen = false;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let read;
      try {
        read = await reader.read();
      } catch (err) {
        if (aborted.current) return;
        // Network drop without an SSE error frame — reconnect.
        setRecoveryReason(
          `connection error: ${err instanceof Error ? err.message : String(err)}`,
        );
        scheduleResume();
        return;
      }
      if (read.done) {
        // Stream ended without `done` or `error` event — treat as
        // unexpected EOF and reconnect.
        setRecoveryReason("connection closed mid-stream");
        scheduleResume();
        return;
      }
      buffer += decoder.decode(read.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (frame.trim().length === 0) continue;
        const parsed = parseFrame(frame);
        if (!parsed) continue;
        if (parsed.event === "done") {
          setPhase("done");
          return;
        }
        if (parsed.event === "error") {
          const data = parsed.data as { reason?: string; last_token?: number };
          setRecoveryReason(data.reason ?? "unknown server-side error");
          // Resume from the server-reported drop position, not the last
          // checkpoint. The drop can land past the last checkpoint (checkpoints
          // fire every CHECKPOINT_EVERY tokens; the drop is independent), and
          // those in-between tokens are already rendered — resuming from the
          // checkpoint would replay and duplicate them at the drop seam (#58).
          lastCheckpoint.current = resumeTokenPosition(
            lastCheckpoint.current,
            data.last_token,
          );
          scheduleResume();
          return;
        }
        // Default — text or checkpoint event.
        const ev = parsed.data as
          | { kind: "text"; index: number; text: string }
          | { kind: "checkpoint"; last_token: number };
        if (ev.kind === "text") {
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            if (phase === "recovering") setPhase("streaming");
          }
          setText((t) => t + ev.text);
        } else if (ev.kind === "checkpoint") {
          lastCheckpoint.current = ev.last_token;
        }
      }
    }
  }

  function scheduleResume(): void {
    if (aborted.current) return;
    const checkpoint = lastCheckpoint.current;
    setRecoveryCount((n) => n + 1);
    setLastResume({ at: checkpoint, when: Date.now() });
    setTimeout(() => {
      if (!aborted.current) void run(checkpoint);
    }, 250); // tiny back-off so the pill is briefly visible
  }

  const showResumedPill =
    lastResume !== null && Date.now() - lastResume.when < 2_500;

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
            {recoveryCount} recovery{recoveryCount > 1 ? "ies" : ""}
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
  readonly data: unknown;
}

function parseFrame(frame: string): ParsedFrame | null {
  let event: string | null = null;
  let dataLine = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice("event: ".length);
    else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
  }
  if (dataLine.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
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
