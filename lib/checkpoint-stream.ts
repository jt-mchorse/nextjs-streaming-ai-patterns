// Deterministic checkpoint-bearing streamer for the error-recovery
// pattern (#5).
//
// The streamer yields one event per call to `next()`. Each event is
// either a `text` chunk or a `checkpoint` event. Checkpoints arrive
// every CHECKPOINT_EVERY tokens and carry the index of the *last*
// emitted text token. A checkpoint is a fallback resume point, not the
// resume point: the drop can land between checkpoints, so the client
// resumes from the furthest position it knows was delivered -- the
// drop's `last_token` if the error frame carries one, else the last
// checkpoint or rendered token. See `resumeTokenPosition` (#58, #80).
//
// `dropAfter` is the session injection: when set, the generator
// throws `CheckpointStreamDropped` once it has emitted that many
// text tokens. The route handler catches this and closes the
// connection mid-response so the recovery path on the client side
// has something to recover from.
//
// Each text event is paced like the three sibling mock streamers: a
// `baseDelayMs + jitter` sleep before it (#230). Without it the whole
// pre-drop burst, and then the whole resumed answer, arrived within a
// millisecond, so the page never showed a token arriving.

import {
  abortableSleep as sleep,
  makePrng,
  validateDelayOptions,
  validateSeed,
} from "@/lib/stream-delay";

export const CHECKPOINT_EVERY = 5;

/**
 * Per-token delay applied when `baseDelayMs` is omitted. The same 30 ms
 * `mockTextStream` and `mockToolStream` use.
 *
 * Read by the generator below AND passed to `validateDelayOptions`, so the
 * guard models the value that actually reaches `setTimeout` (#110).
 */
const DEFAULT_BASE_DELAY_MS = 30;

/** Jitter applied when `jitterMs` is omitted. Same two-readers rule (#110). */
const DEFAULT_JITTER_MS = 30;

const FIXTURE = `A mid-stream error is the single ugliest failure mode for a chat UI: the user has watched
half an answer materialize, the connection drops, and suddenly the entire response disappears
and they're staring at a spinner again. The fix is not to retry from scratch — the model has
already done the expensive part of the work — but to resume from the last token both sides
agree on. This pattern ships a checkpoint protocol that makes recovery transparent: the server
emits a checkpoint event every few tokens carrying the index of the most recently emitted text
token; the client records that index and, on disconnect, reconnects with the index in the
query string so the server resumes from the next token. The browser sees a small "resumed"
indicator and the answer continues where it left off.`;

export interface TextEvent {
  readonly kind: "text";
  readonly index: number; // 1-indexed token position
  readonly text: string;
}

export interface CheckpointEvent {
  readonly kind: "checkpoint";
  readonly last_token: number; // 1-indexed token position
}

export type StreamEvent = TextEvent | CheckpointEvent;

export class CheckpointStreamDropped extends Error {
  readonly emitted: number;
  constructor(emitted: number) {
    super(`stream dropped after ${emitted} text tokens (simulated)`);
    this.name = "CheckpointStreamDropped";
    this.emitted = emitted;
  }
}

export interface StreamOptions {
  /** Resume after this many tokens. 0 (the default) means start fresh. */
  readonly startAfter?: number;
  /**
   * Simulate a mid-stream disconnect after this many additional text
   * tokens are emitted. The generator throws CheckpointStreamDropped
   * when the cap is hit. `undefined` (the default) means stream to
   * completion.
   */
  readonly dropAfter?: number;
  /**
   * Abort signal that ends the stream cleanly at the next event boundary
   * (D-007). When it aborts the generator stops yielding and returns — the
   * route handler owns the `AbortController` and wires both `req.signal` and
   * its `cancel()` into it, so a client disconnect tears down the stream
   * instead of running it to completion.
   */
  readonly signal?: AbortSignal;
  /**
   * Delay before each text event, in ms. Default 30, as in the sibling mock
   * streamers (#230). Pass `baseDelayMs: 0, jitterMs: 0` for an instant
   * stream, the shape tests use.
   */
  readonly baseDelayMs?: number;
  /** Random jitter added to each delay, in ms. Default 30. */
  readonly jitterMs?: number;
  /** Seed for the jitter PRNG; when set the delay schedule is deterministic. */
  readonly seed?: number;
}

/**
 * Tokenize the fixture by whitespace. The capturing split keeps each
 * whitespace run as a token of its own, between the words, so
 * `tokens.join("")` reassembles the original prose exactly. (Splitting on
 * /\s+/ would lose paragraph breaks.) This said `tokens.join(" ")` and that
 * whitespace was "preserved inside each token" until #173; neither was true.
 * `join(" ")` adds a space at every boundary.
 */
function tokenize(): ReadonlyArray<string> {
  return FIXTURE.split(/(\s+)/).filter((t) => t.length > 0);
}

const TOKENS = tokenize();

/** Total number of text tokens the stream will produce on a clean run. */
export const TOTAL_TOKENS = TOKENS.filter((t) => /\S/.test(t)).length;

/**
 * Validate `StreamOptions` numerics so the demo's mid-stream-drop and
 * resume paths can't be silently misrepresented by operator misconfig.
 * Without this guard, `dropAfter = 0` fires the drop on the *first*
 * text event (the `>= dropAfter` check at the drop site is satisfied
 * by `emittedThisRun = 1 >= 0`), contradicting the field's docstring
 * "after this many additional text tokens are emitted" and the "at
 * least one chunk before the connection dies" comment. `startAfter <
 * 0` and `NaN` for either field silently devolve to the defaults
 * (no skip / no drop) without signal.
 *
 * Mirrors the portfolio's contract-tightening sweep (PRs
 * llm-eval-harness#41, llm-cost-optimizer#35, rag-production-kit#37,
 * embedding-model-shootout#30, vector-search-at-scale#28,
 * chunking-strategies-lab#28, python-async-llm-pipelines#31,
 * prompt-regression-suite#36, agent-orchestration-platform#30,
 * mcp-server-cookbook#33).
 */
function validateOptions(options: StreamOptions): void {
  if (options.startAfter !== undefined) {
    if (!Number.isInteger(options.startAfter) || options.startAfter < 0) {
      throw new RangeError(
        `StreamOptions.startAfter must be an integer >= 0; got ${options.startAfter}`,
      );
    }
  }
  if (options.dropAfter !== undefined) {
    if (!Number.isInteger(options.dropAfter) || options.dropAfter < 1) {
      throw new RangeError(
        `StreamOptions.dropAfter must be an integer >= 1; got ${options.dropAfter}`,
      );
    }
  }
  // The delay fields and the seed go through the same shared guards as the
  // sibling mock streamers (#110, #221), so a delay `setTimeout` would clamp
  // to ~1 ms, or a seed `>>> 0` would alias, throws here too (#230).
  validateDelayOptions(options, {
    label: "StreamOptions",
    baseDefault: DEFAULT_BASE_DELAY_MS,
    jitterDefault: DEFAULT_JITTER_MS,
  });
  validateSeed(options.seed, "StreamOptions");
}

/**
 * Where should a client resume after a drop?
 *
 * A client records the most-recent `checkpoint` event's `last_token`, but the
 * server keeps emitting text tokens *between* checkpoints, and the drop is
 * independent of the CHECKPOINT_EVERY cadence — it can (and in this demo does)
 * land past the last checkpoint. The route reports the true drop position in
 * the `error` event's `last_token`. Resuming from the *checkpoint* would make
 * the server replay every token between the checkpoint and the drop, which the
 * client has already rendered — so it would append them a second time
 * (duplicated text at the drop seam). Resume from the furthest-forward known
 * position so no token is shown twice and none is skipped.
 *
 * `droppedAt` is ignored when absent, non-integer, or behind `lastCheckpoint`
 * (e.g. a network drop with no `error` frame carries no drop position) — the
 * recorded checkpoint is the safe fallback in that case.
 */
export function resumeTokenPosition(lastCheckpoint: number, droppedAt?: number): number {
  if (droppedAt === undefined || !Number.isInteger(droppedAt) || droppedAt < lastCheckpoint) {
    return lastCheckpoint;
  }
  return droppedAt;
}

/**
 * Async generator that yields events. Whitespace tokens are folded into the
 * FOLLOWING text event (`" mid-stream"`, never `"A "`), so an event-level
 * consumer doesn't have to special-case them. This said "preceding" until
 * #173, which is the opposite of the loop below.
 *
 * It is also what a resume relies on. With `startAfter: N` the generator skips
 * tokens 1..N, and the whitespace between token N and token N+1 arrives as the
 * prefix of N+1. So the resumed text joins onto what the client already shows,
 * with no space lost or doubled at the seam.
 */
export async function* streamCheckpoints(
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  validateOptions(options);
  const startAfter = options.startAfter ?? 0;
  const dropAfter = options.dropAfter;
  const signal = options.signal;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
  const rand = options.seed !== undefined ? makePrng(options.seed) : Math.random;

  let emittedThisRun = 0;
  let textIndex = 0;

  // Walk the token list, accumulating whitespace into the next text
  // emission so the client receives natural-looking chunks.
  let pendingPrefix = "";
  for (let i = 0; i < TOKENS.length; i++) {
    // D-007: stop at the next event boundary if the consumer disconnected.
    // Checked before any work each iteration so an already-aborted stream
    // yields nothing.
    if (signal?.aborted) {
      return;
    }
    const tok = TOKENS[i];
    if (!/\S/.test(tok)) {
      pendingPrefix += tok;
      continue;
    }
    textIndex += 1;
    if (textIndex <= startAfter) {
      pendingPrefix = ""; // tokens before the resume point are skipped silently
      continue;
    }

    // Pace the text event like the sibling streamers (#230). Skipped tokens
    // above are not paced: a resume should not wait out the tokens it is
    // skipping. `sleep` resolves (not rejects) on abort, so re-check after it
    // rather than emitting a token for a consumer that has gone.
    await sleep(baseDelayMs + Math.floor(rand() * jitterMs), signal);
    if (signal?.aborted) {
      return;
    }

    yield {
      kind: "text",
      index: textIndex,
      text: pendingPrefix + tok,
    };
    pendingPrefix = "";
    emittedThisRun += 1;

    // Emit the checkpoint for this token *before* the drop check. A real
    // server that emits token N with a checkpoint due at N sends the
    // checkpoint and only then dies — so when a drop lands exactly on a
    // checkpoint boundary (`dropAfter` a multiple of CHECKPOINT_EVERY) the
    // client must still receive `checkpoint{last_token: N}`. Otherwise the
    // no-error-frame resume path (resumeTokenPosition falls back to the last
    // *received* checkpoint, checkpoint-stream.ts:132-134) rewinds to the
    // prior checkpoint and replays CHECKPOINT_EVERY already-rendered tokens —
    // the duplicated drop seam this pattern exists to prevent. Sibling to #58.
    if (textIndex % CHECKPOINT_EVERY === 0) {
      yield { kind: "checkpoint", last_token: textIndex };
    }

    // Drop check fires after the text event (and its boundary checkpoint) so
    // the client receives at least one chunk — and any due checkpoint — before
    // the connection dies.
    if (dropAfter !== undefined && emittedThisRun >= dropAfter) {
      throw new CheckpointStreamDropped(textIndex);
    }
  }
}
