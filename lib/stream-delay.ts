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
