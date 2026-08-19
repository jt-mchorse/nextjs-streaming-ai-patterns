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
/** One parsed SSE frame. `event` is null when the frame carried no `event:` line. */
export interface SseFrame {
  readonly event: string | null;
  /** Concatenated `data:` field values, or `""` when the frame carried none. */
  readonly data: string;
}

/**
 * Parse one `\n`-delimited SSE frame into its `event` and `data` fields.
 *
 * This existed in four inlined copies — one per streaming client — and they had
 * diverged on four separate inputs (#93), three of them silently: a dropped
 * frame produces no throw, no log, and no state change. That is the same drift
 * `pumpSseFrames` was extracted to stop in #60; the parser beside it was simply
 * left behind.
 *
 * The wire format's rules that the copies disagreed on:
 *
 * - **The space after the field name is optional.** `data:{"x":1}` is as legal
 *   as `data: {"x":1}`, and exactly one leading space is stripped if present.
 *   Three of the four copies used `startsWith("data: ")`, so the compact form
 *   failed the test, left `dataLine` empty, and the whole frame was discarded.
 * - **`data:` lines accumulate.** `error-recovery-client` assigned (`=`) where
 *   the other three appended (`+=`), so a payload split across two `data:`
 *   lines kept only the last line and then failed to parse.
 * - **The value must be trimmed.** `error-recovery-client` did not, so under
 *   CRLF framing the event name kept its `\r` and every `event === "..."`
 *   comparison downstream silently failed.
 * - **Comment lines (`: keepalive`) and unknown fields (`id:`, `retry:`) are
 *   ignored.** All four already did this, but by falling through rather than
 *   by saying so; it is explicit here.
 *
 * Multi-line `data:` is joined without a separator rather than with the spec's
 * `\n`. All four copies agreed on that and it is what makes a JSON object split
 * across `data:` lines reassemble, so it is preserved deliberately here rather
 * than changed under cover of a divergence fix.
 */
export function parseSseFrame(frame: string): SseFrame {
  let event: string | null = null;
  let data = "";
  for (const line of frame.split("\n")) {
    // A leading colon marks a comment (the conventional keep-alive). Checked
    // before field parsing because ": data: x" is a comment, not a data line.
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    // Strip exactly one optional space after the colon, then trim the rest, so
    // CRLF framing does not leave a `\r` welded to the value.
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    value = value.trim();
    if (field === "event") event = value;
    else if (field === "data") data += value;
    // `id:` and `retry:` are real SSE fields this repo has no use for, and any
    // other field name is unknown. Both are ignored, as before.
  }
  return { event, data };
}

export async function pumpSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onFrame: (frame: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  // A `\r` at the very end of a chunk is held back rather than normalized in
  // place: we cannot yet tell whether it is a lone-CR terminator or the first
  // half of a `\r\n` whose `\n` arrives in the next read. Normalizing it
  // eagerly would turn `...\r` + `\n...` into `\n\n` and manufacture a frame
  // boundary that isn't in the stream — the same read-straddling class the
  // existing "separator split across two reads" case covers.
  let carriageCarry = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // Normalize line terminators before searching for the separator (#95).
    //
    // The WHATWG SSE spec ends a line with ANY of `\r\n`, `\n`, or `\r`, so a
    // blank line — the event separator — has three byte forms. `indexOf("\n\n")`
    // finds exactly one of them: a CRLF blank line is `\r \n \r \n`, which
    // contains no adjacent `\n\n`. Pre-fix, a CRLF- or CR-framed body therefore
    // accumulated every byte in `buf`, never entered the inner loop, and
    // resolved SUCCESSFULLY having called `onFrame` zero times. The component
    // landed on its normal completion path with no content and no error.
    //
    // That was not a hypothetical: `parseSseFrame` below was deliberately
    // hardened for CRLF in #93 ("under CRLF framing the event name kept its
    // `\r`"), and that fix could never fire, because this layer could not
    // deliver a CRLF frame for it to parse. Normalizing here — rather than
    // matching all three separators — makes the two layers agree and keeps the
    // parser's `\r` trim harmless rather than load-bearing.
    let chunk = carriageCarry + decoder.decode(value, { stream: true });
    carriageCarry = "";
    if (chunk.endsWith("\r")) {
      carriageCarry = "\r";
      chunk = chunk.slice(0, -1);
    }
    buf += chunk.replace(/\r\n|\r/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      onFrame(frame);
    }
  }
  // A held-back `\r` that never got its `\n` was a lone-CR terminator after
  // all; the stream is over, so resolve it now. Done before the flush below so
  // a body ending `...\r\r` still separates its last frame properly.
  if (carriageCarry !== "") {
    buf += "\n";
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      onFrame(frame);
    }
  }
  // Anything still in `buf` here is an UNTERMINATED tail, and it is dropped
  // deliberately — see the named contract test "does not emit a trailing
  // partial frame with no terminator" in `test/sse-stream.test.ts`.
  //
  // Flushing it was tried as part of #95 and reverted: an unterminated tail
  // means the stream was truncated mid-frame, so emitting it would hand
  // `parseSseFrame` a half-written payload whose `data:` is very likely
  // truncated JSON. Dropping is the conservative direction. Whether a
  // truncated tail should instead surface as an *error* — rather than either
  // being silently dropped or silently delivered — is a real design question,
  // filed separately rather than decided here.
}
