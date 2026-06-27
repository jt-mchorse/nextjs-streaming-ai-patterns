// Phase model + transitions for the error-recovery streaming demo (#5, #64).
//
// Extracted into lib (cf. lib/optimistic-decision.ts) so the phase-transition
// contract is pure and unit-testable in the node vitest environment, rather
// than living inline in a React client component where it can't be reached.

export type RecoveryPhase =
  | "idle"
  | "streaming"
  | "recovering"
  | "done"
  | "fatal";

/**
 * Decide the phase when the first text chunk of a run arrives.
 *
 * A run that started in `"recovering"` (a resume after a drop) must advance to
 * `"streaming"` so the UI stops showing the amber "recovering…" banner while
 * tokens are actively flowing. Every other phase is left untouched.
 *
 * Written as a pure `(prev) => next` reducer so the component can hand it
 * straight to React's functional `setState` updater — `setPhase(phaseOnFirstChunk)`.
 * That form reads the *live* phase, which is the whole point: the component's
 * `run` closure only ever executes with its render-0 captured `phase` (always
 * `"idle"`), so a direct `if (phase === "recovering")` read can never fire and
 * the banner would sit on "recovering…" for the entire successful resume (#64).
 */
export function phaseOnFirstChunk(prev: RecoveryPhase): RecoveryPhase {
  return prev === "recovering" ? "streaming" : prev;
}
