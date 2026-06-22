import Anthropic from "@anthropic-ai/sdk";

import { mockTextStream } from "./mock-stream";

export interface StreamModeInfo {
  mode: "live" | "mock";
  model: string | null;
}

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Validate a `prompt` at the entry of `streamText` so a misconstructed
 * input fails loud in *both* `live` and `mock` modes the same way (#32).
 *
 * Without this guard the two modes silently diverge:
 *   - `live` mode reaches the Anthropic SDK with an empty `content` body
 *     and the SDK errors at API time (late, noisy, and untrue to the
 *     caller's intent).
 *   - `mock` mode ignores the prompt entirely and emits the canned
 *     stream regardless — the mock token output and the live caller's
 *     mistake are no longer distinguishable.
 *
 * Sibling shape to `validateOptions` in `mock-stream.ts`,
 * `mock-json-stream.ts`, `mock-tool-stream.ts`, and `checkpoint-stream.ts`
 * (#24, #25, #26, #27). `TypeError` for shape, `RangeError` for value —
 * matches the local convention.
 */
function validatePrompt(prompt: string): void {
  if (typeof prompt !== "string") {
    throw new TypeError(
      `streamText(): prompt must be a string; got ${typeof prompt}`,
    );
  }
  if (prompt.length === 0 || prompt.trim().length === 0) {
    throw new RangeError(
      "streamText(): prompt must be a non-empty, non-whitespace string",
    );
  }
}

/**
 * Decide between live Anthropic streaming and the committed mock streamer (D-003).
 *
 * `live` runs when `ANTHROPIC_API_KEY` is set to a non-whitespace value;
 * otherwise we fall back to a deterministic local stream so the demo
 * always works on a fresh clone.
 *
 * `ANTHROPIC_MODEL` is trimmed and, when set to an empty / whitespace-
 * only value, falls back to `DEFAULT_MODEL` (#32). The pre-#32 shape
 * passed an empty string verbatim to the SDK, which surfaced as an API
 * error rather than failing loud against the local fallback.
 */
export function getStreamMode(): StreamModeInfo {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  const hasKey = apiKey.length > 0;
  if (!hasKey) {
    return { mode: "mock", model: null };
  }
  const rawModel = (process.env.ANTHROPIC_MODEL ?? "").trim();
  const model = rawModel.length > 0 ? rawModel : DEFAULT_MODEL;
  return { mode: "live", model };
}

export interface StreamTextOptions {
  /**
   * Optional `AbortSignal` that cancels the stream end-to-end (D-007). When it
   * aborts, generation stops cleanly: the mock path stops at the next token,
   * and the live path aborts the underlying Anthropic request via the SDK's
   * `signal` request option so we stop consuming (and being billed for) a
   * response no one is reading.
   */
  signal?: AbortSignal;
}

/**
 * Yield text deltas for `prompt`. Returns the same `{ text }` shape as the
 * mock streamer so consumers don't branch on mode.
 *
 * `options.signal` makes the stream abortable in *both* modes. This is the
 * stream-source end of the D-007 abort chain (client fetch → route handler →
 * here); without it the route's `cancel()` had nothing to cancel and the live
 * SDK stream ran to completion after a client disconnect, burning tokens.
 */
export async function* streamText(
  prompt: string,
  options: StreamTextOptions = {},
): AsyncGenerator<{ text: string }, void, unknown> {
  validatePrompt(prompt);
  const { signal } = options;
  const { mode, model } = getStreamMode();

  // Already cancelled before we did any work — yield nothing. For the live
  // path this is load-bearing: it returns *before* `new Anthropic()` so an
  // aborted request never opens a network stream.
  if (signal?.aborted) {
    return;
  }

  if (mode === "mock") {
    yield* mockTextStream({ signal });
    return;
  }

  // Live mode — model is guaranteed non-null because mode === "live".
  const client = new Anthropic();
  const stream = client.messages.stream(
    {
      model: model as string,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    },
    // Forward the signal so aborting cancels the underlying HTTP request, not
    // just our local loop — otherwise the SDK keeps the connection open.
    { signal },
  );

  for await (const event of stream) {
    // The SDK aborts the request on `signal`, but re-check here so a late
    // abort stops us yielding a partially-buffered delta as well.
    if (signal?.aborted) {
      return;
    }
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { text: event.delta.text };
    }
  }
}
