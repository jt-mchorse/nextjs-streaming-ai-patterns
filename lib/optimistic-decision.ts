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
// The split is exact 50/50 over the input space (`id` + `click_count`),
// using a small string hash. The first click on each item is biased to
// success so a first-time visitor sees the happy path before any
// rollback animation.

const IMPROVEMENTS: Record<string, ReadonlyArray<string>> = {
  "untitled-1.txt": ["meeting-notes.md", "weekly-roadmap.md", "sales-review.md"],
  "untitled-2.txt": ["spec-2026-q2.md", "design-notes.md", "rfc-streaming.md"],
  "untitled-3.txt": ["onboarding-guide.md", "runbook.md", "team-charter.md"],
  "untitled-4.txt": ["pricing-research.md", "competitor-scan.md", "okrs.md"],
  "untitled-5.txt": ["interview-loop.md", "hiring-rubric.md", "perf-criteria.md"],
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
  // Exact 50/50 split on the low bit; uniform over the input space.
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
 * Used to pin the 50/50 split as a property test, not an aspirational
 * claim.
 */
export function decisionSplitOver(
  ids: ReadonlyArray<string>,
  clickRange: { from: number; to: number },
): { successes: number; failures: number } {
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
