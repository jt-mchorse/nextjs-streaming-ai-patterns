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
 *   comparison downstream silently failed. That is a rule about `event`, and
 *   applying it to `data` broke the accumulation two paragraphs down (#107):
 *   the trim ran *per line, before accumulation*, so a payload split at a
 *   space lost it. `event` keeps the full trim; `data` strips a single
 *   trailing `\r` and nothing else.
 * - **Comment lines (`: keepalive`) and unknown fields (`id:`, `retry:`) are
 *   ignored.** All four already did this, but by falling through rather than
 *   by saying so; it is explicit here.
 *
 * Multi-line `data:` is joined without a separator rather than with the spec's
 * `\n`. All four copies agreed on that and it is what makes a JSON object split
 * across `data:` lines reassemble, so it is preserved deliberately here rather
 * than changed under cover of a divergence fix. It only actually
 * reassembles since #107 -- until then the per-line trim deleted whitespace at
 * every split point, so this paragraph described a property the function did
 * not have.
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
    // Strip exactly one optional space after the colon -- spec behaviour, and
    // the half of the old trim that was always right.
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      // Event names carry no meaningful surrounding whitespace, and the
      // `event === "..."` comparisons the trim was added for (#93) are exactly
      // this field. The full trim stays here.
      event = value.trim();
    } else if (field === "data") {
      // A single trailing `\r` only (#107). The old `value.trim()` ran *per
      // line, before accumulation*, so a payload split across two `data:`
      // lines lost whitespace at the split point -- and the corrupted result
      // still parsed cleanly, so a text delta just quietly lost a space:
      //
      //     data: {"text":"hello \ndata: world"}   ->  {"text":"helloworld"}
      //     data: {"text":"hello\ndata:  world"}   ->  {"text":"helloworld"}
      //     data: {"text":"hel\ndata: lo"}         ->  {"text":"hello"}  (correct)
      //
      // That contradicted the paragraph above, which says joining without a
      // separator "is what makes a JSON object split across `data:` lines
      // reassemble, so it is preserved deliberately". The trim broke the
      // feature its own docstring preserves deliberately.
      //
      // Keeping the `\r` strip preserves what the trim's stated reason
      // actually protects, for a direct caller of this exported function who
      // did not come through `createSseFramer` -- which normalizes `\r\n` and
      // `\r` to `\n`, and whose comment already says that normalization
      // "keeps the parser's `\r` trim harmless rather than load-bearing".
      // Since #106 every in-repo SSE reader goes through the framer, so no
      // in-repo frame reaching here carries a `\r` at all.
      data += value.endsWith("\r") ? value.slice(0, -1) : value;
    }
    // `id:` and `retry:` are real SSE fields this repo has no use for, and any
    // other field name is unknown. Both are ignored, as before.
  }
  return { event, data };
}

/**
 * Incremental SSE frame splitter: the wire-format rules, in one place.
 *
 * `pumpSseFrames` owns a read loop; this owns the *framing*. They were the same
 * function until #106, and that is why the fix in #95 only reached half the
 * codebase. Two of the four SSE clients — `streaming-text-client` and
 * `error-recovery-client` — cannot use `pumpSseFrames`, because they need their
 * own read loop: the first checks a `cancelled` flag between reads, and the
 * second wraps each individual `reader.read()` in a `try` to tell a network
 * drop from an SSE error frame, then returns early from inside frame handling
 * on a `done`/`error` event. So they had copies of the loop, and the copies
 * predate #95:
 *
 *     body                          pumpSseFrames   streaming-text   error-recovery
 *     LF framing (control)          2 frame(s)      2 frame(s)       2 frame(s)
 *     CRLF framing                  2 frame(s)      0 frame(s)       0 frame(s)
 *     CR framing                    2 frame(s)      0 frame(s)       0 frame(s)
 *     LF, last frame unterminated   1 frame(s)      1 frame(s)       1 frame(s)
 *
 * Zero frames, silently: the buffer accumulates every byte, the inner scan
 * never matches, the loop falls out on `done`, and the component lands on its
 * normal completion path with an empty pane.
 *
 * Splitting the framer out — rather than copying the normalization into the two
 * components a third and fourth time — is what makes a fifth client impossible
 * to get wrong. `test/sse-framing-parity.test.ts` locks that no file under
 * `components/` scans for a separator itself.
 *
 * The rules, all three of which the copies were missing:
 *
 * - **Normalize `\r\n` and `\r` to `\n` before scanning.** The WHATWG SSE spec
 *   ends a line with ANY of `\r\n`, `\n`, or `\r`, so a blank line — the event
 *   separator — has three byte forms. `indexOf("\n\n")` finds exactly one: a
 *   CRLF blank line is `\r \n \r \n`, which contains no adjacent `\n\n` (#95).
 * - **Hold back a trailing `\r`.** At the end of a chunk we cannot yet tell a
 *   lone-CR terminator from the first half of a `\r\n` whose `\n` is in the next
 *   read. Normalizing it eagerly turns `...\r` + `\n...` into `\n\n` and
 *   manufactures a frame boundary that is not in the stream.
 * - **Drop the unterminated tail.** Anything left after the final separator was
 *   a truncated frame; `flush` resolves a held-back `\r` but deliberately does
 *   not emit the remainder. See the named contract test in
 *   `test/sse-stream.test.ts`.
 */
export interface SseFramer {
  /** Feed one decoded chunk; returns every frame completed by it, in order. */
  push(chunk: string): string[];
  /** Call once the stream is done; resolves a held-back lone-CR terminator. */
  flush(): string[];
}

export function createSseFramer(): SseFramer {
  let buf = "";
  let carriageCarry = "";

  const drain = (): string[] => {
    const out: string[] = [];
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      out.push(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
    return out;
  };

  return {
    push(chunk: string): string[] {
      let text = carriageCarry + chunk;
      carriageCarry = "";
      if (text.endsWith("\r")) {
        carriageCarry = "\r";
        text = text.slice(0, -1);
      }
      buf += text.replace(/\r\n|\r/g, "\n");
      return drain();
    },
    flush(): string[] {
      // A held-back `\r` that never got its `\n` was a lone-CR terminator after
      // all; the stream is over, so resolve it. Done before we give up on the
      // remainder so a body ending `...\r\r` still separates its last frame.
      if (carriageCarry === "") return [];
      carriageCarry = "";
      buf += "\n";
      return drain();
      // `buf` may still hold an UNTERMINATED tail here, dropped deliberately.
      // Flushing it was tried as part of #95 and reverted: an unterminated tail
      // means the stream was truncated mid-frame, so emitting it would hand
      // `parseSseFrame` a half-written payload whose `data:` is very likely
      // truncated JSON. Dropping is the conservative direction. Whether a
      // truncated tail should instead surface as an *error* is a real design
      // question, filed separately rather than decided here.
    },
  };
}

/**
 * Pump a `\n\n`-framed SSE body, invoking `onFrame` for each complete frame in
 * order. Resolves when the stream ends (`done`). If the underlying
 * `reader.read()` rejects — e.g. the caller's `AbortController` fired — the
 * rejection propagates so the caller can land on the right terminal phase
 * (`interrupted` for an `AbortError`, otherwise `error`). A frame split across
 * multiple reads is buffered until its terminator arrives.
 *
 * A thin read loop over `createSseFramer`, which owns every wire-format rule.
 * Use this when your read loop has nothing to say; use the framer directly when
 * it does (see `error-recovery-client`, which classifies each read's failure).
 */
export async function pumpSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onFrame: (frame: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const framer = createSseFramer();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const frame of framer.push(decoder.decode(value, { stream: true }))) {
      onFrame(frame);
    }
  }
  // Flush the DECODER before the framer (#115). `{ stream: true }` holds back a
  // trailing incomplete UTF-8 sequence waiting for the rest of it; if the body
  // ended mid-codepoint those bytes are never emitted at all, so the framer
  // never learns they existed. The argument-less call releases them as U+FFFD.
  //
  // Measured: this changes no frame today. Across LF/CRLF/CR-framed bodies with
  // multibyte payloads, every byte-truncation of each, and read-chunk sizes
  // {1,2,3,5,whole}, the frames emitted are identical with and without it — the
  // held bytes only exist when the stream ended mid-codepoint, which means the
  // framer is holding an unterminated tail, which `flush()` deliberately drops.
  // It is here because it is free and provably neutral, and because #97 is open
  // about whether that truncated tail should surface as an error: if it ever
  // does, U+FFFD is the evidence, and it has to have survived to be it (D-013).
  for (const frame of framer.push(decoder.decode())) onFrame(frame);
  for (const frame of framer.flush()) onFrame(frame);
}
