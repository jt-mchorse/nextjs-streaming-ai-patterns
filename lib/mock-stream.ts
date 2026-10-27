// Deterministic mock streamer used when ANTHROPIC_API_KEY is not set, so the
// repo runs on a fresh clone without an Anthropic account (D-003).
//
// The point of the mock isn't to *pretend* to call the API — it's to give the
// streaming-render pattern a realistic input shape (per-token chunks with
// natural-feeling jitter) so the UI under test is exercised end-to-end.

import {
  abortableSleep as sleep,
  makePrng,
  validateDelayOptions,
  validateSeed,
} from "@/lib/stream-delay";

export interface MockStreamOptions {
  /** Per-token delay in ms. Default 30. */
  baseDelayMs?: number;
  /** Random jitter added to base delay, in ms. Default 30. */
  jitterMs?: number;
  /**
   * Optional seed for the jitter PRNG. When set, the token sequence AND the
   * per-token delay schedule are deterministic. It does not skip the delay
   * (#206): pass `baseDelayMs: 0, jitterMs: 0` for an instant stream, the
   * same as `mockToolStream` / `mockJsonStream`.
   */
  seed?: number;
  /**
   * Optional `AbortSignal` that ends the stream cleanly at the next
   * yield. Parity with `mockToolStream` / `mockJsonStream`. Aborting
   * during an in-flight inter-token delay cuts the wait short. The
   * text-stream event shape is just `{ text: string }`, so there is
   * no "interrupted" event to yield — the generator returns and the
   * route layer's SSE `done` event is what the client sees.
   */
  signal?: AbortSignal;
}

const FIXTURE = `Streaming the model's response token-by-token instead of waiting for the whole
message is the single biggest perceived-latency win in a chat UI.

The pattern works because rendering can start the moment the first token arrives.
React 19's Server Components flush HTML in chunks as the async generator yields,
and the browser repaints incrementally. No client-side JavaScript is required
just to display the streaming text — only to animate the cursor.

If the model takes 2.5 seconds to produce 80 tokens, a non-streaming UI shows
nothing for 2.5 seconds and then a wall of text. A streaming UI shows the first
token at ~80ms and grows from there. Same wall clock, very different feel.`;


/**
 * Per-token delay applied when `baseDelayMs` is omitted.
 *
 * Read by the generator below AND passed to `validateDelayOptions`, so the
 * guard models the value that actually reaches `setTimeout`. Before #110 the
 * guard hard-coded `0` here while the generator used this number, and the
 * config it approved was the one that overflowed the 32-bit clamp.
 */
const DEFAULT_BASE_DELAY_MS = 30;

/** Jitter applied when `jitterMs` is omitted. Same two-readers rule (#110). */
const DEFAULT_JITTER_MS = 30;

/**
 * Validate `MockStreamOptions`'s delay fields.
 *
 * The rule lives in `lib/stream-delay.ts` (#110). It was inlined here, in
 * `mock-json-stream.ts` and in `mock-tool-stream.ts` as three byte-identical
 * copies, and all three defaulted an omitted field to `0` while their
 * generators defaulted it to a real delay -- one rule in three places is how
 * a rule gets fixed in two of them. The `label` keeps the error messages
 * byte-identical to the copy this replaces.
 */
function validateOptions(options: MockStreamOptions): void {
  validateDelayOptions(options, {
    label: "MockStreamOptions",
    baseDefault: DEFAULT_BASE_DELAY_MS,
    jitterDefault: DEFAULT_JITTER_MS,
  });
  // `seed` is checked here too, so a seed that `>>> 0` would alias onto
  // another seed's schedule throws like a bad delay does (#221).
  validateSeed(options.seed, "MockStreamOptions");
}

/**
 * Yield a fixed paragraph token-by-token. The yielded shape is `{ text: string }`
 * so consumers can treat it identically to the Anthropic SDK's text-delta event
 * (`{ delta: { text } }`) by mapping once.
 *
 * Honors `options.signal`: when the signal aborts, the generator stops
 * yielding new tokens and returns cleanly (parity with
 * `mockToolStream` / `mockJsonStream`).
 */
export async function* mockTextStream(
  options: MockStreamOptions = {},
): AsyncGenerator<{ text: string }, void, unknown> {
  validateOptions(options);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
  const rand = options.seed !== undefined ? makePrng(options.seed) : Math.random;
  const signal = options.signal;

  // Token boundary: split on whitespace but keep the whitespace attached to
  // the previous token, so reconstructed string === FIXTURE.
  const tokens = chunkByWhitespace(FIXTURE);
  for (const token of tokens) {
    if (signal?.aborted) return;
    // The delay runs whether or not `seed` is set (#206). It used to be
    // skipped on "seed implies test", so the seed never seeded any jitter and
    // `baseDelayMs`/`jitterMs` were validated and then ignored -- unlike the
    // sibling streamers. Honor `signal` during the wait so an interrupt
    // mid-pause unblocks the loop immediately.
    const delay = baseDelayMs + Math.floor(rand() * jitterMs);
    await sleep(delay, signal);
    if (signal?.aborted) return;
    yield { text: token };
  }
}

export function chunkByWhitespace(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of s) {
    buf += ch;
    if (/\s/.test(ch)) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

export const MOCK_FIXTURE = FIXTURE;
