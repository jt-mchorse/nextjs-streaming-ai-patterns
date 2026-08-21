// Deterministic mock streamer used when ANTHROPIC_API_KEY is not set, so the
// repo runs on a fresh clone without an Anthropic account (D-003).
//
// The point of the mock isn't to *pretend* to call the API — it's to give the
// streaming-render pattern a realistic input shape (per-token chunks with
// natural-feeling jitter) so the UI under test is exercised end-to-end.

export interface MockStreamOptions {
  /** Per-token delay in ms. Default 30. */
  baseDelayMs?: number;
  /** Random jitter added to base delay, in ms. Default 30. */
  jitterMs?: number;
  /**
   * Optional seed for the jitter PRNG. When set, the stream is fully
   * deterministic — used by the test suite.
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
 * Largest delay `setTimeout` honours. Above this Node warns
 * `TimeoutOverflowWarning: ... does not fit into a 32-bit signed integer.
 * Timeout duration was set to 1.` on stderr and fires after ~1 ms, so a
 * deliberately-slow stream silently becomes an instantaneous one (#102).
 *
 * Measured, first event delivered with a 250 ms budget: `2**31 - 2` and
 * `2**31 - 1` stay pending; `2**31`, `2**32`, `5e9` and `MAX_SAFE_INTEGER` all
 * fire in 0-4 ms. The bound is the clamp itself, not a round number.
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Validate `MockStreamOptions` at the entry of `mockTextStream` (#26).
 *
 * Sibling pattern to `validateOptions` in `checkpoint-stream.ts` (#24),
 * but on the bounded-non-negative-finite-ms domain rather than the
 * positive-integer-index domain. `setTimeout` silently coerces NaN/Infinity
 * in `sleep`: every token dumped instantly, streaming UX silently broken in
 * the demo.
 *
 * This used to add "Infinity hung forever on the first sleep (~24-50 day
 * setTimeout clamp)". That is not what happens, and the mistake mattered
 * (#102). Measured in Node:
 *
 *     TimeoutOverflowWarning: Infinity does not fit into a 32-bit signed
 *     integer. Timeout duration was set to 1.
 *     Infinity fired after ~4ms
 *     NaN      fired after ~5ms
 *
 * Both clamp to 1 ms; neither hangs. Believing large values were *slow* is
 * precisely why nothing bounded them from above — see `MAX_TIMEOUT_MS`, which
 * closes the finite half of the same hazard.
 */
function validateOptions(options: MockStreamOptions): void {
  // The finiteness/sign checks below close the NaN and Infinity halves of the
  // hazard. The comment on this guard has always named the 32-bit `setTimeout`
  // clamp as the reason -- and a *finite* delay at or above `2**31` hits that
  // same clamp, reproducing the NaN outcome exactly: every token dumped
  // instantly, streaming UX silently broken. `Infinity` at least fails loud;
  // `5e9` silently did the opposite of what was asked (#102).
  //
  // Only reached when `seed` is undefined -- the seeded path skips `sleep`
  // entirely -- but validated unconditionally, as before.
  for (const [field, value] of [
    ["baseDelayMs", options.baseDelayMs],
    ["jitterMs", options.jitterMs],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `MockStreamOptions.${field} must be a finite non-negative number; got ${value}`,
      );
    }
    if (value > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `MockStreamOptions.${field} must be <= ${MAX_TIMEOUT_MS} (2**31 - 1), the largest delay ` +
          `setTimeout honours; above it the timer fires after ~1ms instead, turning a slow ` +
          `stream into an instantaneous one; got ${value}`,
      );
    }
  }
  // `setTimeout` receives `baseDelayMs + floor(rand() * jitterMs)`, not either
  // field alone, so the two checks above can both pass while the value that
  // actually reaches the timer is over the clamp. Measured with
  // `baseDelayMs=2147483598` and `jitterMs=200` -- both individually legal --
  // 11 of 12 runs collapsed to ~1ms and 1 honoured the delay, the same config
  // working or breaking on a jitter draw. Bound the maximum the sum can reach,
  // at construction, rather than leaving it to chance at each token.
  const maxDelay = (options.baseDelayMs ?? 0) + (options.jitterMs ?? 0);
  if (maxDelay > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `MockStreamOptions: baseDelayMs + jitterMs must be <= ${MAX_TIMEOUT_MS} (2**31 - 1); ` +
        `got ${maxDelay}. Each field is individually in range, but setTimeout receives ` +
        `their sum, and above the clamp it fires after ~1ms instead of waiting`,
    );
  }
}

function makePrng(seed: number): () => number {
  // Mulberry32 — small, fast, deterministic-given-seed.
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  const baseDelayMs = options.baseDelayMs ?? 30;
  const jitterMs = options.jitterMs ?? 30;
  const rand = options.seed !== undefined ? makePrng(options.seed) : Math.random;
  const signal = options.signal;

  // Token boundary: split on whitespace but keep the whitespace attached to
  // the previous token, so reconstructed string === FIXTURE.
  const tokens = chunkByWhitespace(FIXTURE);
  for (const token of tokens) {
    if (signal?.aborted) return;
    if (options.seed === undefined) {
      // Real wall-clock delay in dev; skipped under test (seed implies test).
      // Honor `signal` during the wait so an interrupt mid-pause unblocks
      // the loop immediately rather than completing the token's wait first.
      const delay = baseDelayMs + Math.floor(rand() * jitterMs);
      await sleep(delay, signal);
      if (signal?.aborted) return;
    }
    yield { text: token };
  }
}

/**
 * `setTimeout`-based sleep that resolves early when `signal` aborts.
 * Same shape used in `mock-tool-stream.ts` / `mock-json-stream.ts`.
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(t);
        resolve();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
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
