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
 * Async generator that yields events. Whitespace tokens are folded
 * into the preceding text event so an event-level consumer doesn't
 * have to special-case them.
 */
export async function* streamCheckpoints(
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  const startAfter = options.startAfter ?? 0;
  const dropAfter = options.dropAfter;

  let emittedThisRun = 0;
  let textIndex = 0;

  // Walk the token list, accumulating whitespace into the next text
  // emission so the client receives natural-looking chunks.
  let pendingPrefix = "";
  for (let i = 0; i < TOKENS.length; i++) {
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
