/**
 * Deterministic mock streamer for the partial-JSON pattern (#3).
 *
 * Emits a structured "trip itinerary" payload in chunked pieces using
 * the same SSE-event shape as the other patterns (D-006):
 *
 *   json_delta*   — the next slice of the response's JSON content
 *   message_stop  — final terminator
 *
 * The single `json_delta` event type keeps the protocol surface
 * minimal: the client accumulates the deltas into a buffer and runs
 * `parsePartialJson` on each new accumulation, re-rendering with
 * whatever structure is currently parsable.
 *
 * The canned payload mirrors the kind of structured response a model
 * commonly produces (top-level fields plus an array of objects with
 * nested fields) so the progressive UI has something interesting to
 * render at multiple intermediate states.
 */

export type JsonStreamEvent =
  | { type: "json_delta"; delta: string }
  | { type: "message_stop"; stop_reason: "end_turn" | "interrupted" };

export interface MockJsonStreamOptions {
  /** Per-chunk delay in ms. Default 80. */
  baseDelayMs?: number;
  /** Random jitter added to delay. Default 40. */
  jitterMs?: number;
  /** Seed for the jitter PRNG; when set the stream is deterministic. */
  seed?: number;
  /** Abort signal that ends the stream cleanly at the next yield. */
  signal?: AbortSignal;
}

/**
 * The committed demo response. Long enough to show field-by-field and
 * array-element-by-element progress; short enough that a tester can
 * read the final value at a glance.
 */
const FULL_RESPONSE = {
  destination: "Austin, TX",
  trip_length_days: 3,
  summary: "A long weekend mixing live music, food trucks, and a green-belt walk.",
  daily_plan: [
    {
      day: 1,
      morning: "Breakfast tacos at Veracruz, then walk Lady Bird Lake trail.",
      afternoon: "Pool at Barton Springs.",
      evening: "Live music on Rainey Street.",
    },
    {
      day: 2,
      morning: "Slow coffee at Houndstooth + Bouldin Acres farmers market.",
      afternoon: "Texas State Capitol tour + Bullock Texas State History Museum.",
      evening: "Franklin Barbecue for dinner (line opens at 5pm).",
    },
    {
      day: 3,
      morning: "Hike McKinney Falls State Park.",
      afternoon: "Continental Club matinee.",
      evening: "Departure: barbecue takeout from Terry Black's.",
    },
  ],
  budget_estimate_usd: 850,
};

function chunkPayload(payload: unknown): string[] {
  const json = JSON.stringify(payload);
  // Split into chunks that *don't* always fall on clean boundaries —
  // sometimes mid-key, mid-value, mid-array — so the parser is
  // exercised across the realistic failure modes. We do this by
  // emitting fixed-width slices in the 8-15 char range.
  const out: string[] = [];
  let i = 0;
  // A pseudo-random but deterministic chunk schedule.
  const schedule = [11, 9, 13, 8, 14, 10, 12, 9, 15, 11, 8, 13, 10, 14, 9, 12, 11, 10];
  let s = 0;
  while (i < json.length) {
    const width = schedule[s % schedule.length] ?? 12;
    out.push(json.slice(i, i + width));
    i += width;
    s += 1;
  }
  return out;
}

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
 * Validate `MockJsonStreamOptions` at the entry of `mockJsonStream` (#26).
 * Sibling to `validateOptions` in `mock-stream.ts` and `mock-tool-stream.ts`.
 */
function validateOptions(options: MockJsonStreamOptions): void {
  // The finiteness/sign checks below close the NaN and Infinity halves of the
  // hazard. The comment on this guard has always named the 32-bit `setTimeout`
  // clamp as the reason -- and a *finite* delay at or above `2**31` hits that
  // same clamp, reproducing the NaN outcome exactly: every token dumped
  // instantly, streaming UX silently broken. `Infinity` at least fails loud;
  // `5e9` silently did the opposite of what was asked (#102).
  for (const [field, value] of [
    ["baseDelayMs", options.baseDelayMs],
    ["jitterMs", options.jitterMs],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `MockJsonStreamOptions.${field} must be a finite non-negative number; got ${value}`,
      );
    }
    if (value > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `MockJsonStreamOptions.${field} must be <= ${MAX_TIMEOUT_MS} (2**31 - 1), the largest delay ` +
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
      `MockJsonStreamOptions: baseDelayMs + jitterMs must be <= ${MAX_TIMEOUT_MS} (2**31 - 1); ` +
        `got ${maxDelay}. Each field is individually in range, but setTimeout receives ` +
        `their sum, and above the clamp it fires after ~1ms instead of waiting`,
    );
  }
}

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    if (signal) {
      const onAbort = () => {
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

/**
 * Yield the canned JSON-stream event sequence.
 *
 * Abort behavior matches the other patterns: aborting `signal`
 * causes the generator to yield a final `message_stop` with
 * `stop_reason: "interrupted"` and return cleanly so the HTTP route
 * closes the SSE stream without a broken-pipe error visible to the
 * client.
 */
export async function* mockJsonStream(
  options: MockJsonStreamOptions = {},
): AsyncGenerator<JsonStreamEvent, void, unknown> {
  validateOptions(options);
  const base = options.baseDelayMs ?? 80;
  const jitter = options.jitterMs ?? 40;
  const seed = options.seed;
  const rand = seed !== undefined ? makePrng(seed) : Math.random;
  const signal = options.signal;

  function delay(): number {
    return base + Math.floor(rand() * jitter);
  }

  function checkAborted(): boolean {
    return signal?.aborted ?? false;
  }

  const chunks = chunkPayload(FULL_RESPONSE);
  for (const chunk of chunks) {
    if (checkAborted()) {
      yield { type: "message_stop", stop_reason: "interrupted" };
      return;
    }
    await sleep(delay(), signal);
    if (checkAborted()) {
      yield { type: "message_stop", stop_reason: "interrupted" };
      return;
    }
    yield { type: "json_delta", delta: chunk };
  }
  await sleep(delay(), signal);
  // The final sleep is a race window like every other: `sleep` resolves (not
  // rejects) on abort, so an abort landing here must still surface as
  // `interrupted` rather than a clean `end_turn` — otherwise the SSE route
  // reports a completed turn for a stream the client actually cancelled, and
  // the documented abort contract (yield `interrupted` and return) is broken.
  if (checkAborted()) {
    yield { type: "message_stop", stop_reason: "interrupted" };
    return;
  }
  yield { type: "message_stop", stop_reason: "end_turn" };
}

/** Exposed for tests so a regression in the canned payload is visible. */
export const _MOCK_JSON_FULL_RESPONSE: unknown = FULL_RESPONSE;
