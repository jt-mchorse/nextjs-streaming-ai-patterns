/**
 * An error after tokens keeps the streamed text on screen (#218).
 *
 * `streaming-text-client` rendered EITHER the error line OR the text, so a run
 * that streamed words and then ended in error replaced them with the error --
 * whose own wording (`STREAM_TEXT_ENDED_WITHOUT_DONE`) says "the text above may
 * be incomplete". Since #167 every live answer cut at `max_tokens` took this
 * path.
 *
 * The other component tests stop at the setter calls; this bug is in the JSX,
 * so it needs the rendered markup. Two passes over the real component: the
 * first runs the effect against a stubbed `fetch` and folds every setter call
 * into a per-slot store; the second calls the component again with the effect
 * off, so `useState` hands back the final state, and renders what it returns.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STREAM_TEXT_ENDED_WITHOUT_DONE } from "../lib/sse-stream";

const store: unknown[] = [];
let slot = 0;
let runEffects = true;

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const mine = slot++;
    if (!(mine in store)) store[mine] = initial;
    const set = (v: unknown) => {
      store[mine] = typeof v === "function" ? (v as (p: unknown) => unknown)(store[mine]) : v;
    };
    return [store[mine], set];
  },
  useEffect: (fn: () => void) => {
    if (runEffects) fn();
  },
}));

const enc = new TextEncoder();
// Slots in declaration order: 0 text, 1 status, 2 errorMessage.
const STATUS = 1;

async function render(chunks: string[]): Promise<{ status: unknown; html: string }> {
  store.length = 0;
  slot = 0;
  runEffects = true;
  // The test transform compiles JSX to a bare `React.createElement`; the
  // second pass needs the real one so the tree can be rendered.
  const React = await vi.importActual<typeof import("react")>("react");
  vi.stubGlobal("React", React);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200 })),
  );
  const { StreamingTextClient } = await import("../components/streaming-text-client");
  StreamingTextClient({ prompt: "hi" });
  const terminal = () => store[STATUS] === "done" || store[STATUS] === "error";
  for (let n = 0; n < 200 && !terminal(); n++) await new Promise((r) => setTimeout(r, 1));

  slot = 0;
  runEffects = false;
  const html = renderToStaticMarkup(StreamingTextClient({ prompt: "hi" }));
  return { status: store[STATUS], html };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The hunt agent's repro: two text frames, then EOF or an `event: error`.
const FRAMES = [
  `data: ${JSON.stringify({ text: "Streaming the model's response " })}\n\n`,
  `data: ${JSON.stringify({ text: "token-by-token " })}\n\n`,
];
const STREAMED = "Streaming the model&#x27;s response token-by-token";
const MAX_TOKENS = "the model stopped with stop_reason=max_tokens; the answer is incomplete";
const errorFrame = (message: string) =>
  `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`;

describe("an error after tokens keeps the streamed text (#218)", () => {
  it("frames then EOF shows the text and the ended-without-done error", async () => {
    const { status, html } = await render(FRAMES);
    expect(status).toBe("error");
    expect(html).toContain(STREAMED);
    expect(html).toContain(`stream error: ${STREAM_TEXT_ENDED_WITHOUT_DONE}`);
    // "the text above": the error line comes after the text, not before it.
    expect(html.indexOf(STREAMED)).toBeLessThan(html.indexOf("stream error:"));
  });

  it("frames then event: error shows the text and the error frame's message", async () => {
    const { status, html } = await render([...FRAMES, errorFrame(MAX_TOKENS)]);
    expect(status).toBe("error");
    expect(html).toContain(STREAMED);
    expect(html).toContain(`stream error: ${MAX_TOKENS}`);
    expect(html.indexOf(STREAMED)).toBeLessThan(html.indexOf("stream error:"));
  });

  it("a cut stream keeps no blinking cursor on the kept text", async () => {
    const { html } = await render(FRAMES);
    expect(html).not.toContain("token-blink");
  });
});

describe("controls", () => {
  it("an error before any frame shows just the error", async () => {
    const { status, html } = await render([errorFrame("upstream 529")]);
    expect(status).toBe("error");
    expect(html).toContain("stream error: upstream 529");
    expect(html).not.toContain("whitespace-pre-wrap");
  });

  it("an empty 200 body shows just the ended-without-done error", async () => {
    const { html } = await render([]);
    expect(html).toContain(`stream error: ${STREAM_TEXT_ENDED_WITHOUT_DONE}`);
    expect(html).not.toContain("whitespace-pre-wrap");
  });

  it("a finished answer shows the text and no error line", async () => {
    const { status, html } = await render([...FRAMES, "event: done\ndata: {}\n\n"]);
    expect(status).toBe("done");
    expect(html).toContain(STREAMED);
    expect(html).not.toContain("stream error");
    expect(html).not.toContain("token-blink");
  });
});
