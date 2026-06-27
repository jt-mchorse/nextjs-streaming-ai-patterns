// Deterministic checkpoint-bearing streamer for the error-recovery
// pattern (#5).
//
// The streamer yields one event per call to `next()`. Each event is
// either a `text` chunk or a `checkpoint` event. Checkpoints arrive
// every CHECKPOINT_EVERY tokens and carry the index of the *last*
// emitted text token — so a client that records the most-recent
// checkpoint knows exactly where to resume after a drop.
//
// `dropAfter` is the session injection: when set, the generator
// throws `CheckpointStreamDropped` once it has emitted that many
// text tokens. The route handler catches this and closes the
// connection mid-response so the recovery path on the client side
// has something to recover from.

export const CHECKPOINT_EVERY = 5;

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
}

/**
 * Tokenize the fixture by whitespace. Whitespace is preserved inside
 * each token so reassembling tokens with `tokens.join(" ")` yields the
 * original prose. (Splitting on /\s+/ would lose paragraph breaks.)
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
 * Async generator that yields events. Whitespace tokens are folded
 * into the preceding text event so an event-level consumer doesn't
 * have to special-case them.
 */
export async function* streamCheckpoints(
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  validateOptions(options);
  const startAfter = options.startAfter ?? 0;
  const dropAfter = options.dropAfter;
  const signal = options.signal;

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

    yield {
      kind: "text",
      index: textIndex,
      text: pendingPrefix + tok,
    };
    pendingPrefix = "";
    emittedThisRun += 1;

    // Drop check fires after the text event so the client receives
    // at least one chunk before the connection dies.
    if (dropAfter !== undefined && emittedThisRun >= dropAfter) {
      throw new CheckpointStreamDropped(textIndex);
    }

    if (textIndex % CHECKPOINT_EVERY === 0) {
      yield { kind: "checkpoint", last_token: textIndex };
    }
  }
}
