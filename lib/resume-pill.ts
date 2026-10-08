/**
 * How long the error-recovery demo's "resumed at token N" pill stays up after
 * a reconnect, and how much of that window is left (#152).
 *
 * The pill used to be decided only during render, as
 * `Date.now() - lastResume.when < 2_500`, and nothing scheduled a render when
 * the window closed. The resumed stream finishes in under a second, so the
 * last render happened inside the window and the pill stayed on screen for
 * good: measured on a mock-mode `next dev`, still showing 10 s after "done".
 * The component now schedules the clear with this function's result.
 */
export const RESUMED_PILL_MS = 2_500;

/**
 * Milliseconds until a pill shown at `shownAt` must hide, measured at `now`;
 * `0` once the window has closed. Never negative, so it can be handed to
 * `setTimeout` directly. A clock that moved backwards is clamped to the full
 * window rather than read as a longer one.
 */
export function resumedPillRemainingMs(shownAt: number, now: number): number {
  const elapsed = now - shownAt;
  if (!Number.isFinite(elapsed)) return 0;
  if (elapsed < 0) return RESUMED_PILL_MS;
  return Math.max(0, RESUMED_PILL_MS - elapsed);
}

/** Whether a pill shown at `shownAt` is still inside its window at `now`. */
export function isResumedPillVisible(shownAt: number, now: number): boolean {
  return resumedPillRemainingMs(shownAt, now) > 0;
}
