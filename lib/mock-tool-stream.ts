/**
 * Deterministic mock streamer for the tool-use pattern (#2).
 *
 * Emits the same event shape an Anthropic tool-use stream produces, in
 * order:
 *
 *   text_delta*        — opening commentary from the model
 *   tool_use_start     — declares the tool the model wants to call
 *   tool_use_delta*    — JSON args streaming in chunk-by-chunk
 *   tool_use_stop      — args complete; runtime executes the tool
 *   tool_result        — synthetic result the demo injects
 *   text_delta*        — resumed model output after seeing the result
 *   message_stop       — final terminator
 *
 * Why mirror the SDK's frame shape: the same client renderer should
 * work against either path (mock during CI / `next dev` without an
 * API key, live Anthropic with one). Routing the difference at the
 * stream-source layer rather than at the render layer keeps the
 * client component honest.
 */

export type ToolStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; tool_use_id: string; tool_name: string }
  | { type: "tool_use_delta"; partial_json: string }
  | { type: "tool_use_stop" }
  | { type: "tool_result"; tool_use_id: string; result: unknown }
  | { type: "message_stop"; stop_reason: "end_turn" | "interrupted" };

export interface MockToolStreamOptions {
  /** Per-frame delay in ms. Default 30. */
  baseDelayMs?: number;
  /** Random jitter added to delay. Default 30. */
  jitterMs?: number;
  /** Seed for the jitter PRNG; when set the stream is deterministic. */
  seed?: number;
  /** Abort signal that ends the stream cleanly at the next yield. */
  signal?: AbortSignal;
}

/**
 * The committed demo scenario: the model is asked about Austin's weather,
 * decides to call `get_weather`, sees the result, then completes its answer.
 * Long enough to demonstrate every frame type; short enough that a tester
 * can read it in a glance.
 */
const PRE_TOOL_TEXT = "Let me check the current weather for Austin so I can give you an accurate answer.";
const POST_TOOL_TEXT = "Austin is currently sunny at 22°C. That's good walking weather; you'll probably want a light jacket if you're heading out after sunset.";
const TOOL_NAME = "get_weather";
const TOOL_USE_ID = "toolu_demo_01";
const TOOL_ARGS_FULL = JSON.stringify({ city: "Austin", units: "celsius" });
const TOOL_RESULT = { city: "Austin", condition: "sunny", temperature_c: 22 };

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
 * Validate `MockToolStreamOptions` at the entry of `mockToolStream` (#26).
 * Sibling to `validateOptions` in `mock-stream.ts` and `mock-json-stream.ts`.
 */
function validateOptions(options: MockToolStreamOptions): void {
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
        `MockToolStreamOptions.${field} must be a finite non-negative number; got ${value}`,
      );
    }
    if (value > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `MockToolStreamOptions.${field} must be <= ${MAX_TIMEOUT_MS} (2**31 - 1), the largest delay ` +
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
      `MockToolStreamOptions: baseDelayMs + jitterMs must be <= ${MAX_TIMEOUT_MS} (2**31 - 1); ` +
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

function tokenize(text: string): string[] {
  // Split on word boundaries but keep punctuation attached to the
  // previous token, so the stream looks like real model output.
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    cur += ch;
    if (ch === " " || ch === "\n") {
      out.push(cur);
      cur = "";
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Yield the canned tool-use event sequence.
 *
 * The `signal` propagation is the same shape `AbortController` provides
 * to `fetch`: aborting the controller causes the generator to yield a
 * terminal `message_stop` with `stop_reason: "interrupted"` and then
 * return. The HTTP route forwards this to the client so the interrupt
 * button produces a clean transcript instead of a half-written
 * connection error.
 */
export async function* mockToolStream(
  options: MockToolStreamOptions = {},
): AsyncGenerator<ToolStreamEvent, void, unknown> {
  validateOptions(options);
  const base = options.baseDelayMs ?? 30;
  const jitter = options.jitterMs ?? 30;
  const seed = options.seed;
  const rand = seed !== undefined ? makePrng(seed) : Math.random;
  const signal = options.signal;

  function delay(): number {
    return base + Math.floor(rand() * jitter);
  }

  function checkAborted(): boolean {
    return signal?.aborted ?? false;
  }

  // Phase 1: pre-tool text.
  for (const tok of tokenize(PRE_TOOL_TEXT)) {
    if (checkAborted()) {
      yield { type: "message_stop", stop_reason: "interrupted" };
      return;
    }
    await sleep(delay(), signal);
    if (checkAborted()) {
      yield { type: "message_stop", stop_reason: "interrupted" };
      return;
    }
    yield { type: "text_delta", text: tok };
  }

  // Phase 2: tool_use start.
  if (checkAborted()) {
    yield { type: "message_stop", stop_reason: "interrupted" };
    return;
  }
  await sleep(delay(), signal);
  // `sleep` resolves (not rejects) on abort, so re-check after it — matching
  // the other phases — before declaring a tool the client already cancelled (#40).
  if (checkAborted()) {
    yield { type: "message_stop", stop_reason: "interrupted" };
    return;
  }
  yield {
    type: "tool_use_start",
    tool_use_id: TOOL_USE_ID,
    tool_name: TOOL_NAME,
  };

  // Phase 3: tool args streaming in. Real models emit the JSON in
  // chunks rather than all at once; mimic by sending the args in three
  // bites so the UI can render a partial-JSON skeleton.
  const argChunks = [
    TOOL_ARGS_FULL.slice(0, 18),
    TOOL_ARGS_FULL.slice(18, 30),
    TOOL_ARGS_FULL.slice(30),
  ];
  for (const c of argChunks) {
    if (checkAborted()) {
      yield { type: "message_stop", stop_reason: "interrupted" };
      return;
    }
    await sleep(delay(), signal);
    // `sleep` resolves (not rejects) on abort, so re-check after it — matching
    // phases 1 and 5 — before emitting the next event (#40).
    if (checkAborted()) {
      yield { type: "message_stop", stop_reason: "interrupted" };
      return;
    }
    yield { type: "tool_use_delta", partial_json: c };
  }

  // Phase 4: tool_use stop + injected tool_result.
  if (checkAborted()) {
    yield { type: "message_stop", stop_reason: "interrupted" };
    return;
  }
  await sleep(delay(), signal);
  if (checkAborted()) {
    yield { type: "message_stop", stop_reason: "interrupted" };
    return;
  }
  yield { type: "tool_use_stop" };
  await sleep(delay(), signal);
  // Without this check an abort during the sleep would still inject a
  // fabricated tool_result for a tool call the client already cancelled.
  if (checkAborted()) {
    yield { type: "message_stop", stop_reason: "interrupted" };
    return;
  }
  yield { type: "tool_result", tool_use_id: TOOL_USE_ID, result: TOOL_RESULT };

  // Phase 5: post-tool text.
  for (const tok of tokenize(POST_TOOL_TEXT)) {
    if (checkAborted()) {
      yield { type: "message_stop", stop_reason: "interrupted" };
      return;
    }
    await sleep(delay(), signal);
    if (checkAborted()) {
      yield { type: "message_stop", stop_reason: "interrupted" };
      return;
    }
    yield { type: "text_delta", text: tok };
  }

  // Phase 6: clean stop.
  await sleep(delay(), signal);
  // Final-sleep race window — an abort here must report `interrupted`, not a
  // clean `end_turn` for a stream the client cancelled (#40).
  if (checkAborted()) {
    yield { type: "message_stop", stop_reason: "interrupted" };
    return;
  }
  yield { type: "message_stop", stop_reason: "end_turn" };
}
