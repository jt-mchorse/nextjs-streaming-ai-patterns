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

/**
 * Yield text deltas for `prompt`. Returns the same `{ text }` shape as the
 * mock streamer so consumers don't branch on mode.
 */
export async function* streamText(prompt: string): AsyncGenerator<{ text: string }, void, unknown> {
  validatePrompt(prompt);
  const { mode, model } = getStreamMode();

  if (mode === "mock") {
    yield* mockTextStream();
    return;
  }

  // Live mode — model is guaranteed non-null because mode === "live".
  const client = new Anthropic();
  const stream = client.messages.stream({
    model: model as string,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { text: event.delta.text };
    }
  }
}
