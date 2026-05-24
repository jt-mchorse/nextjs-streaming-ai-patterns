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
