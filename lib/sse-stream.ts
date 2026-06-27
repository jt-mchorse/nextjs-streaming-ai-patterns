/**
 * Shared SSE read-loop pump for the streaming client components.
 *
 * `tool-use-client` and `partial-json-client` both consume a `\n\n`-framed SSE
 * body the same way: pull from the reader, decode, split out each complete
 * frame, and hand it to a frame handler. Previously each inlined this
 * `while (true)` loop *without* error handling, so when the user clicked
 * Interrupt the in-flight `reader.read()` rejected with an `AbortError` that
 * escaped `run()` as an unhandled rejection — the component never reached the
 * documented `interrupted` terminal state and the UI wedged with Run/Interrupt
 * disabled (see `docs/tool-use-state-machine.md` and #60). Centralizing the
 * loop here lets each caller wrap a single `await pumpSseFrames(...)` in a
 * try/catch and classify the outcome with `isAbortError`.
 */

/**
 * True when an error is a fetch/stream `AbortController.abort()` rejection.
 *
 * A real abort rejects with a `DOMException` whose `name` is `"AbortError"`;
 * we match structurally (just `.name`) so a plain abort-shaped object works in
 * tests and across runtimes that don't expose `DOMException`.
 */
export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null | undefined)?.name === "AbortError";
}

/**
 * Pump a `\n\n`-framed SSE body, invoking `onFrame` for each complete frame in
 * order. Resolves when the stream ends (`done`). If the underlying
 * `reader.read()` rejects — e.g. the caller's `AbortController` fired — the
 * rejection propagates so the caller can land on the right terminal phase
 * (`interrupted` for an `AbortError`, otherwise `error`). A frame split across
 * multiple reads is buffered until its `\n\n` terminator arrives.
 */
export async function pumpSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onFrame: (frame: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      onFrame(frame);
    }
  }
}
