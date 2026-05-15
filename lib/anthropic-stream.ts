import Anthropic from "@anthropic-ai/sdk";

import { mockTextStream } from "./mock-stream";

export interface StreamModeInfo {
  mode: "live" | "mock";
  model: string | null;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Decide between live Anthropic streaming and the committed mock streamer (D-003).
 *
 * `live` runs when `ANTHROPIC_API_KEY` is set; otherwise we fall back to a
 * deterministic local stream so the demo always works on a fresh clone.
 */
export function getStreamMode(): StreamModeInfo {
  const hasKey = (process.env.ANTHROPIC_API_KEY ?? "").length > 0;
  return {
    mode: hasKey ? "live" : "mock",
    model: hasKey ? (process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL) : null,
  };
}

/**
 * Yield text deltas for `prompt`. Returns the same `{ text }` shape as the
 * mock streamer so consumers don't branch on mode.
 */
export async function* streamText(prompt: string): AsyncGenerator<{ text: string }, void, unknown> {
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
