// Deterministic decision oracle for the optimistic-rollback demo (#4).
//
// The pattern's load-bearing UX is the *rollback* path — the user has to
// see what happens when the optimistic update reverts. That can't be a
// rare event; it has to fire reliably enough for a casual visitor to
// observe it, and reproducibly enough for tests to pin both branches.
//
// `decide({ id, click_count })` returns one of:
//
//   { ok: true, improved_name }   — commit the optimistic update
//   { ok: false, reason }         — roll back with the rendered reason
//
// The first click on each item is biased to success so a first-time visitor
// sees the happy path before any rollback animation. **Subsequent** clicks
// split exactly 50/50, using a small string hash — that qualifier is
// load-bearing and was missing here until #100.
//
// Measured over the five demo ids:
//
//   clicks 2..11    -> 25 / 25       exactly even
//   clicks 2..1001  -> 2500 / 2500   exactly even
//   clicks 1..10    -> 27 / 23       54% success
//   clicks 1..2     -> 8 / 2         80% success
//   clicks 1..1     -> 5 / 0         100% success
//
// The hash half really is exact, not approximate. What the unqualified "50/50
// over the input space" claim got wrong was the first-click bias introduced a
// few lines below it. D-010's own rationale has always said "subsequent clicks
// split 50/50"; every restatement but one dropped it.
//
// The practical consequence is worth keeping in view given the header above: a
// visitor who clicks twice sees the rollback 20% of the time, not half.

const IMPROVEMENTS: Record<string, ReadonlyArray<string>> = {
  "untitled-1.txt": [
    "meeting-notes.md",
    "weekly-roadmap.md",
    "sales-review.md",
  ],
  "untitled-2.txt": ["spec-2026-q2.md", "design-notes.md", "rfc-streaming.md"],
  "untitled-3.txt": ["onboarding-guide.md", "runbook.md", "team-charter.md"],
  "untitled-4.txt": ["pricing-research.md", "competitor-scan.md", "okrs.md"],
  "untitled-5.txt": [
    "interview-loop.md",
    "hiring-rubric.md",
    "perf-criteria.md",
  ],
};

const REFUSAL_REASONS: ReadonlyArray<string> = [
  "the model couldn't find a stronger name than the current placeholder",
  "the model wasn't confident enough to commit a new name",
  "the model proposed a name that collided with an existing file",
];

/**
 * Default name set for the demo's seed list.
 */
export const DEMO_NAMES: ReadonlyArray<string> = [
  "untitled-1.txt",
  "untitled-2.txt",
  "untitled-3.txt",
  "untitled-4.txt",
  "untitled-5.txt",
];

export interface DecisionInput {
  /** The item's id — matches one of DEMO_NAMES, or a custom string in tests. */
  readonly id: string;
  /** How many times the user has clicked "improve" for this id (1-indexed). */
  readonly click_count: number;
}

export type Decision =
  | { readonly ok: true; readonly improved_name: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Tiny dependency-free string hash. Not cryptographic — just stable.
 */
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Decide whether the LLM's improvement commits or rolls back. The split
 * is deterministic so the rollback path is testable by construction.
 */
export function decide(input: DecisionInput): Decision {
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new Error("decide(): id must be a non-empty string");
  }
  if (!Number.isInteger(input.click_count) || input.click_count < 1) {
    throw new Error("decide(): click_count must be a positive integer");
  }

  // First click on each id always succeeds — the happy path leads.
  if (input.click_count === 1) {
    return { ok: true, improved_name: pickImprovement(input.id, 0) };
  }

  const seed = hash(`${input.id}:${input.click_count}`);
  // Exact 50/50 split on the low bit, uniform over click_count >= 2. The
  // click_count === 1 branch above returns before reaching here, so this is
  // the *subsequent-click* split D-010 names — not a split over the whole
  // input space (#100).
  const succeed = (seed & 1) === 0;
  if (succeed) {
    return { ok: true, improved_name: pickImprovement(input.id, seed) };
  }
  return { ok: false, reason: pickReason(seed) };
}

function pickImprovement(id: string, seed: number): string {
  const options = IMPROVEMENTS[id];
  if (!options || options.length === 0) {
    // Custom id (e.g., in tests with arbitrary strings) — fall back to a
    // generic improved name that's still deterministic.
    return `${id.replace(/\.[^.]+$/, "")}-improved.md`;
  }
  return options[seed % options.length] ?? options[0];
}

function pickReason(seed: number): string {
  return REFUSAL_REASONS[seed % REFUSAL_REASONS.length] ?? REFUSAL_REASONS[0];
}

/**
 * Diagnostic helper for the README + tests: returns the count of
 * success/failure outcomes when called over a fixed range of inputs.
 * Used to pin the split as a property test, not an aspirational claim.
 *
 * Note which split it can evidence: over a range starting at 1 the result is
 * skewed by `decide`'s deliberate first-click bias, so a 50/50 assertion has
 * to start at 2. The suite's own property test does exactly that, and its
 * name says so.
 */
export function decisionSplitOver(
  ids: ReadonlyArray<string>,
  clickRange: { from: number; to: number },
): { successes: number; failures: number } {
  // Validate the range the same way `decide` validates its own inputs.
  // Without this, a degenerate range yields a silently-meaningless result:
  // an inverted `{ from: 5, to: 2 }` runs zero iterations and returns
  // `{ 0, 0 }` — letting the "50/50 after the first click" property test pass
  // vacuously on
  // zero samples — and a sub-1 / non-integer bound throws from deep inside
  // `decide` with an opaque `click_count` message that points at the wrong
  // thing. This helper's whole job is to make the split *evidenced*, so a
  // range that produces no evidence must fail loud here.
  //
  // `ids` is the other operand of the same product, and it was unguarded
  // (#100). An empty `ids` runs zero iterations and returns `{ 0, 0 }` — the
  // exact silently-meaningless result the comment above says must fail loud,
  // reached through the operand it doesn't mention. Degenerate *elements* are
  // already covered: `[""]` and `[null]` both throw from `decide`'s own id
  // guard. It is only the empty container that slipped through.
  if (ids.length === 0) {
    throw new Error(
      "decisionSplitOver(): ids must be non-empty; an empty id set produces zero " +
        "samples, and a split measured over zero samples is not evidence",
    );
  }

  const { from, to } = clickRange;
  if (!Number.isInteger(from) || from < 1) {
    throw new Error(
      `decisionSplitOver(): clickRange.from must be a positive integer; got ${from}`,
    );
  }
  if (!Number.isInteger(to) || to < 1) {
    throw new Error(
      `decisionSplitOver(): clickRange.to must be a positive integer; got ${to}`,
    );
  }
  if (from > to) {
    throw new Error(
      `decisionSplitOver(): clickRange.from (${from}) must be <= clickRange.to (${to})`,
    );
  }

  let successes = 0;
  let failures = 0;
  for (const id of ids) {
    for (let c = clickRange.from; c <= clickRange.to; c++) {
      const d = decide({ id, click_count: c });
      if (d.ok) successes += 1;
      else failures += 1;
    }
  }
  return { successes, failures };
}
