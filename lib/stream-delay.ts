// Shared delay-option validation for the mock streamers (#110).
//
// `mock-stream.ts`, `mock-json-stream.ts` and `mock-tool-stream.ts` each carried
// a byte-identical copy of this guard, and all three were wrong the same way:
// the sum check defaulted an omitted field to `0` while the generator defaulted
// it to 30 (80/40 in the JSON streamer), so the guard checked a smaller number
// than the one that reached `setTimeout` and approved exactly the config that
// overflows. Three copies of one rule is how a rule gets fixed in two places;
// this is the one copy. Same reasoning `#106` used to centralize the SSE framer.

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
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** The two delay fields every mock streamer's options object carries. */
export interface DelayOptions {
  readonly baseDelayMs?: number;
  readonly jitterMs?: number;
}

export interface DelayDefaults {
  /**
   * The options-interface name to put in error messages, e.g.
   * `"MockStreamOptions"`. Parameterized rather than generic so the messages
   * stay byte-identical to the three inlined copies this replaces.
   */
  readonly label: string;
  /**
   * The value the *generator* substitutes for an omitted `baseDelayMs`. Pass
   * the same constant the generator reads -- that identity is the whole fix
   * (#110), and `test/stream-delay-defaults.test.ts` locks it.
   */
  readonly baseDefault: number;
  /** As `baseDefault`, for `jitterMs`. */
  readonly jitterDefault: number;
}

/**
 * Validate the delay fields, rejecting anything `setTimeout` would silently
 * turn into ~1 ms.
 *
 * Three checks, in order:
 *
 * 1. Each present field is finite and non-negative. `setTimeout` coerces
 *    `NaN`/`Infinity` rather than refusing them -- measured in Node,
 *    `Infinity` fired after ~4 ms and `NaN` after ~5 ms, both with a
 *    `TimeoutOverflowWarning` (#26, corrected by #102).
 * 2. Each present field is within the clamp on its own.
 * 3. **The sum**, which is the operand `setTimeout` actually receives:
 *    `baseDelayMs + floor(rand() * jitterMs)`. Two individually-legal fields
 *    can sum past the clamp -- measured with `baseDelayMs=2147483598` and
 *    `jitterMs=200`, 11 of 12 runs collapsed to ~1 ms and one honoured the
 *    delay, the same config working or breaking on a jitter draw (#102).
 *
 * The sum uses `?? baseDefault` / `?? jitterDefault`, **not `?? 0`**. That was
 * the bug (#110): with `?? 0`, `{ baseDelayMs: 2**31 - 1 }` and no `jitterMs`
 * made the guard compute `2**31 - 1 + 0` and pass, while the generator computed
 * `2**31 - 1 + floor(rand() * 30)` and overflowed on 29 draws in 30. Measured
 * on the real modules: first event after 3 ms (`mockTextStream`) and 1 ms
 * (`mockJsonStream`) for a delay of ~24.8 days.
 *
 * The bound stays `base + jitter` rather than the exact `base + jitter - 1`
 * (`floor(rand() * jitter)` tops out at `jitter - 1`). That is the contract
 * `#102` documented and its error message states; a 1 ms over-rejection at the
 * 24.8-day boundary is not worth changing a shipped contract for.
 */
export function validateDelayOptions(options: DelayOptions, defaults: DelayDefaults): void {
  const { label, baseDefault, jitterDefault } = defaults;
  for (const [field, value] of [
    ["baseDelayMs", options.baseDelayMs],
    ["jitterMs", options.jitterMs],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${label}.${field} must be a finite non-negative number; got ${value}`);
    }
    if (value > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `${label}.${field} must be <= ${MAX_TIMEOUT_MS} (2**31 - 1), the largest delay ` +
          `setTimeout honours; above it the timer fires after ~1ms instead, turning a slow ` +
          `stream into an instantaneous one; got ${value}`,
      );
    }
  }
  const maxDelay = (options.baseDelayMs ?? baseDefault) + (options.jitterMs ?? jitterDefault);
  if (maxDelay > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `${label}: baseDelayMs + jitterMs must be <= ${MAX_TIMEOUT_MS} (2**31 - 1); ` +
        `got ${maxDelay}. Each field is individually in range, but setTimeout receives ` +
        `their sum, and above the clamp it fires after ~1ms instead of waiting`,
    );
  }
}

/** Largest `seed` the PRNG can tell apart: it reads the seed as `seed >>> 0`. */
export const MAX_SEED = 2 ** 32 - 1;

/**
 * Validate a mock streamer's `seed`, the one numeric option the delay guard
 * above never covered (#221).
 *
 * Each streamer's Mulberry32 PRNG starts from `seed >>> 0`, which coerces
 * rather than refusing: `NaN`, `Infinity` and `2**32` all become `0`, `1.9`
 * becomes `1`, and `-1` becomes `4294967295`. A seed is documented to pick the
 * schedule, so distinct seeds silently sharing one is the same silent-coercion
 * hazard `baseDelayMs`/`jitterMs` already throw on (#26, #102). Measured on
 * `mockTextStream({ baseDelayMs: 0, jitterMs: 1000 })`: seeds 0, `NaN`, `2**32`
 * and `Infinity` all scheduled `266,223,146,467`.
 *
 * So `seed` must be an integer in `[0, 2**32 - 1]`, the exact domain on which
 * `>>> 0` is the identity. An omitted seed means "use `Math.random`" and stays
 * legal.
 */
export function validateSeed(seed: number | undefined, label: string): void {
  if (seed === undefined) return;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new RangeError(
      `${label}.seed must be an integer in [0, ${MAX_SEED}] (2**32 - 1); the PRNG reads it as ` +
        `seed >>> 0, so any other value silently aliases another seed's schedule; got ${seed}`,
    );
  }
}

/**
 * `setTimeout`-based sleep that resolves early when `signal` aborts.
 *
 * One copy, shared by the three mock streamers, for the reason the guard above
 * is shared (#110). Each streamer had its own, and all three removed their
 * `abort` listener only when the abort fired (#179). `{ once: true }` removes a
 * listener after it *runs*; on a stream nobody aborts -- every normal request --
 * it never runs, so each inter-token delay left one listener on the route's
 * signal. Measured on full un-aborted runs: 115 listeners left by
 * `mockTextStream`, 65 by `mockJsonStream`, 45 by `mockToolStream`, and on
 * Node 20 a single mock-mode `GET /api/stream-text` printed
 * `MaxListenersExceededWarning: Possible EventTarget memory leak detected`.
 *
 * The timer path now removes the listener it added, so at most one is live per
 * pending sleep and none outlive it. Abort still resolves immediately.
 */
export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
