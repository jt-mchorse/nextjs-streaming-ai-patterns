// Count-label pluralization for the streaming demo UIs (#66).
//
// Two client components render "<n> <noun>" count chips inline. Both hand-rolled
// the singular/plural choice as a ternary, and the error-recovery chip got it
// wrong: `recovery{n > 1 ? "ies" : ""}` produced "2 recoveryies" (it appended
// "ies" to the whole word instead of replacing the trailing "y"). Inline JSX in
// a client component can't be reached from the node/vitest suite, so — per the
// `recovery-phase.ts` extraction (#64) — the rendering logic moves here as a
// pure function that the suite can pin directly.

/**
 * Render a count with its noun: `pluralizeCount(2, "recovery", "recoveries")`
 * → `"2 recoveries"`, `pluralizeCount(1, "recovery", "recoveries")`
 * → `"1 recovery"`.
 *
 * The singular is used iff the count is exactly 1 (English: 0 and negatives
 * take the plural — "0 recoveries", "0 days"). When `plural` is omitted it
 * defaults to `singular + "s"`, which is correct for regular nouns ("day" →
 * "days") but wrong for any noun whose plural isn't a bare `-s` suffix
 * ("recovery" → "recoveries", not "recoverys"); pass `plural` explicitly for
 * those. Dependency-free and pure (D-008) so it's unit-testable and carries no
 * React/runtime coupling.
 */
export function pluralizeCount(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${count} ${word}`;
}
