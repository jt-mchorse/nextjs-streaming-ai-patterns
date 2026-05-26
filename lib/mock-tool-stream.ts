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
 * Validate `MockToolStreamOptions` at the entry of `mockToolStream` (#26).
 * Sibling to `validateOptions` in `mock-stream.ts` and `mock-json-stream.ts`.
 */
function validateOptions(options: MockToolStreamOptions): void {
  if (options.baseDelayMs !== undefined) {
    if (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs < 0) {
      throw new RangeError(
        `MockToolStreamOptions.baseDelayMs must be a finite non-negative number; got ${options.baseDelayMs}`,
      );
    }
  }
  if (options.jitterMs !== undefined) {
    if (!Number.isFinite(options.jitterMs) || options.jitterMs < 0) {
      throw new RangeError(
        `MockToolStreamOptions.jitterMs must be a finite non-negative number; got ${options.jitterMs}`,
      );
    }
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
    yield { type: "tool_use_delta", partial_json: c };
  }

  // Phase 4: tool_use stop + injected tool_result.
  if (checkAborted()) {
    yield { type: "message_stop", stop_reason: "interrupted" };
    return;
  }
  await sleep(delay(), signal);
  yield { type: "tool_use_stop" };
  await sleep(delay(), signal);
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
  yield { type: "message_stop", stop_reason: "end_turn" };
}
