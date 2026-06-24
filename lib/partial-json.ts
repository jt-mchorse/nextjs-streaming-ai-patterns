/**
 * Incremental JSON parser for streaming model output (#3).
 *
 * Given a JSON string that may be truncated mid-token, return the best
 * parsable structured value seen so far. Never throws; the worst case
 * is `{ value: null, isComplete: false }`.
 *
 * The strategy is to "close" the document by appending whatever
 * brackets, quotes, or values are needed for the partial input to be
 * valid JSON — dropping any tokens that would have changed the shape
 * of an already-parsed value (the last half-typed key/value pair in
 * an object, for instance) before closing. Then `JSON.parse` runs on
 * the repaired string. This avoids hand-rolling a streaming parser
 * while still surfacing every field that has been completely
 * transmitted.
 *
 * Why dep-free (D-008): the repo is a reference for *patterns*. A
 * vendored 100-line parser shows the technique transparently;
 * importing the `partial-json` or `json-parse-stream` npm package
 * hides exactly the thing this page is supposed to teach. The
 * tradeoff is documented in the core decisions log.
 */

export interface PartialJsonResult<T = unknown> {
  /** Best parsable value seen so far. `null` for unrecoverable input. */
  value: T | null;
  /** True when the buffer parsed without any repair — i.e. it's a complete JSON document. */
  isComplete: boolean;
}

/**
 * Parse a possibly-truncated JSON string.
 *
 * The function tolerates:
 * - Empty input → `{ value: null, isComplete: false }`.
 * - A complete JSON document → `{ value, isComplete: true }`.
 * - An open string mid-value → drops everything from the open string
 *   forward (the half-typed key or value vanishes; everything before
 *   it survives).
 * - An open array or object → appends the missing closers.
 * - Trailing commas → trimmed before close.
 * - A primitive prefix that isn't yet a token boundary (`tru`, `12.`)
 *   → drops back to the previous complete value.
 *
 * On truly unrecoverable input (e.g., a buffer with no balanced
 * brackets at all), returns `{ value: null, isComplete: false }`
 * rather than throwing.
 */
export function parsePartialJson<T = unknown>(buffer: string): PartialJsonResult<T> {
  const trimmed = buffer.trimStart();
  if (trimmed.length === 0) {
    return { value: null, isComplete: false };
  }

  // Fast path: the buffer is already valid JSON.
  try {
    const value = JSON.parse(buffer) as T;
    return { value, isComplete: true };
  } catch {
    // Fall through to repair.
  }

  const repaired = repair(buffer);
  if (repaired === null) {
    return { value: null, isComplete: false };
  }
  try {
    const value = JSON.parse(repaired) as T;
    return { value, isComplete: false };
  } catch {
    return { value: null, isComplete: false };
  }
}

/**
 * Walk the buffer once with a tiny per-frame state machine, then emit
 * a shortened-and-closed version that's valid JSON.
 *
 * Each open frame tracks its own `lastSafeEnd` — the offset in the
 * buffer up to which we can safely truncate *that frame* and still
 * have a parsable structure. The frame's `expecting` discriminator
 * (`key | colon | value | comma_or_close`) tells us when to advance
 * `lastSafeEnd`: only after a complete value lands, after a comma
 * commits the previous value, or after the opening bracket itself
 * (so empty objects/arrays are reachable).
 *
 * Returns `null` when the buffer can't be coerced into valid JSON
 * even after dropping its tail and closing open structures.
 */
function repair(buffer: string): string | null {
  type ObjectExpecting = "key" | "colon" | "value" | "comma_or_close";
  type ArrayExpecting = "value" | "comma_or_close";
  type Frame =
    | { kind: "object"; lastSafeEnd: number; expecting: ObjectExpecting; committedAny: boolean }
    | { kind: "array"; lastSafeEnd: number; expecting: ArrayExpecting; committedAny: boolean };

  const stack: Frame[] = [];

  // After the deepest frame closes, the value is committed to the
  // parent (or the top level). When parsing fast-fails but the whole
  // value is structurally complete (e.g. trailing junk), this catches it.
  let topLevelComplete = false;
  // Offset just past a *completed* top-level value (bare literal, or a closed
  // top-level object/array). Lets us re-emit the committed value when trailing
  // junk makes the whole-buffer JSON.parse fail and we fall into repair —
  // without it, `frameSnapshot(buffer, [])` returns null and the value is lost.
  let topLevelEnd = -1;

  let i = 0;
  while (i < buffer.length) {
    const ch = buffer[i] as string;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    const frame = stack[stack.length - 1];

    // Top level — only one value allowed, but stream may not have started.
    if (!frame) {
      if (topLevelComplete || topLevelEnd >= 0) break; // junk after top-level value
      if (ch === "{") {
        stack.push({ kind: "object", lastSafeEnd: i + 1, expecting: "key", committedAny: false });
        i += 1;
        continue;
      }
      if (ch === "[") {
        stack.push({ kind: "array", lastSafeEnd: i + 1, expecting: "value", committedAny: false });
        i += 1;
        continue;
      }
      // Bare top-level value (number / true / false / null / string).
      const consumed = consumeLiteralOrString(buffer, i);
      if (consumed === null) return null; // unrecoverable
      if (consumed.complete) {
        topLevelComplete = true;
        topLevelEnd = consumed.endIndex;
        i = consumed.endIndex;
        continue;
      }
      return null;
    }

    if (frame.kind === "object") {
      if (frame.expecting === "key") {
        if (ch === "}") {
          // Empty object or trailing comma already swallowed — close.
          stack.pop();
          commitChildToParent(stack, i + 1);
          if (stack.length === 0) topLevelEnd = i + 1; // closed top-level value
          i += 1;
          continue;
        }
        if (ch === '"') {
          const closed = consumeString(buffer, i);
          if (closed === null) return frameSnapshot(buffer, stack); // open key — drop
          if (!closed.complete) return frameSnapshot(buffer, stack);
          frame.expecting = "colon";
          i = closed.endIndex;
          continue;
        }
        // Anything else here is unexpected — bail to snapshot.
        return frameSnapshot(buffer, stack);
      }
      if (frame.expecting === "colon") {
        if (ch === ":") {
          frame.expecting = "value";
          i += 1;
          continue;
        }
        return frameSnapshot(buffer, stack);
      }
      if (frame.expecting === "value") {
        if (ch === "{") {
          stack.push({ kind: "object", lastSafeEnd: i + 1, expecting: "key", committedAny: false });
          i += 1;
          continue;
        }
        if (ch === "[") {
          stack.push({ kind: "array", lastSafeEnd: i + 1, expecting: "value", committedAny: false });
          i += 1;
          continue;
        }
        const consumed = consumeLiteralOrString(buffer, i);
        if (consumed === null) return frameSnapshot(buffer, stack);
        if (!consumed.complete) return frameSnapshot(buffer, stack);
        // Value committed — advance frame's safe boundary past the value.
        frame.lastSafeEnd = consumed.endIndex;
        frame.expecting = "comma_or_close";
        frame.committedAny = true;
        i = consumed.endIndex;
        continue;
      }
      if (frame.expecting === "comma_or_close") {
        if (ch === ",") {
          frame.lastSafeEnd = i + 1;
          frame.expecting = "key";
          i += 1;
          continue;
        }
        if (ch === "}") {
          stack.pop();
          commitChildToParent(stack, i + 1);
          if (stack.length === 0) topLevelEnd = i + 1; // closed top-level value
          i += 1;
          continue;
        }
        return frameSnapshot(buffer, stack);
      }
    }

    if (frame.kind === "array") {
      if (frame.expecting === "value") {
        if (ch === "]") {
          stack.pop();
          commitChildToParent(stack, i + 1);
          if (stack.length === 0) topLevelEnd = i + 1; // closed top-level value
          i += 1;
          continue;
        }
        if (ch === "{") {
          stack.push({ kind: "object", lastSafeEnd: i + 1, expecting: "key", committedAny: false });
          i += 1;
          continue;
        }
        if (ch === "[") {
          stack.push({ kind: "array", lastSafeEnd: i + 1, expecting: "value", committedAny: false });
          i += 1;
          continue;
        }
        const consumed = consumeLiteralOrString(buffer, i);
        if (consumed === null) return frameSnapshot(buffer, stack);
        if (!consumed.complete) return frameSnapshot(buffer, stack);
        frame.lastSafeEnd = consumed.endIndex;
        frame.expecting = "comma_or_close";
        frame.committedAny = true;
        i = consumed.endIndex;
        continue;
      }
      if (frame.expecting === "comma_or_close") {
        if (ch === ",") {
          frame.lastSafeEnd = i + 1;
          frame.expecting = "value";
          i += 1;
          continue;
        }
        if (ch === "]") {
          stack.pop();
          commitChildToParent(stack, i + 1);
          if (stack.length === 0) topLevelEnd = i + 1; // closed top-level value
          i += 1;
          continue;
        }
        return frameSnapshot(buffer, stack);
      }
    }
  }

  // A top-level value completed (then we hit trailing junk or end-of-buffer):
  // re-emit just that value. frameSnapshot would return null on the now-empty
  // stack, dropping a value the caller already fully received.
  if (stack.length === 0 && topLevelEnd >= 0) {
    return buffer.slice(0, topLevelEnd);
  }
  return frameSnapshot(buffer, stack);
}

/**
 * Commit a just-closed child frame to its parent's expecting/safeEnd
 * state, or to top-level. `closeIndex` is the index just after the
 * `}` or `]` that closed the child.
 */
function commitChildToParent(
  stack: { lastSafeEnd: number; expecting: string; committedAny: boolean }[],
  closeIndex: number,
): void {
  const parent = stack[stack.length - 1];
  if (!parent) return; // closed the top-level frame — handled by caller
  // The parent now has a fully-committed value (the child structure).
  parent.lastSafeEnd = closeIndex;
  parent.expecting = "comma_or_close";
  parent.committedAny = true;
}

/**
 * Produce the repaired buffer from the current stack snapshot. We
 * walk the stack from innermost outward, popping any frames that
 * have no committed content (e.g. an object opened but with only a
 * trailing key fragment, no value). The remaining stack is sliced
 * up to its deepest frame's `lastSafeEnd`, trailing commas and
 * whitespace are stripped, and the open frames are closed.
 */
function frameSnapshot(
  buffer: string,
  stack: {
    kind: "object" | "array";
    lastSafeEnd: number;
    committedAny: boolean;
  }[],
): string | null {
  if (stack.length === 0) return null;

  // Pop innermost frames that have no committed content. We always
  // keep at least the outermost frame so empty containers (`{}`,
  // `[]`) remain reachable instead of collapsing to `null`.
  const trimmed = stack.slice();
  while (trimmed.length > 1) {
    const top = trimmed[trimmed.length - 1];
    if (top && !top.committedAny) {
      trimmed.pop();
    } else {
      break;
    }
  }

  const innermost = trimmed[trimmed.length - 1];
  if (!innermost) return null;

  let prefix = buffer.slice(0, innermost.lastSafeEnd);
  prefix = prefix.replace(/[\s,]+$/u, "");
  for (let k = trimmed.length - 1; k >= 0; k--) {
    const f = trimmed[k];
    if (!f) continue;
    prefix += f.kind === "array" ? "]" : "}";
  }
  return prefix.length > 0 ? prefix : null;
}

/**
 * Try to consume a single JSON value starting at `start` — string,
 * number, true, false, or null. Returns `null` for definitely-invalid
 * starts (e.g. an unexpected punctuator). When the value is in
 * progress but parseable later, returns `complete: false`.
 */
function consumeLiteralOrString(
  buffer: string,
  start: number,
): { endIndex: number; complete: boolean } | null {
  const ch = buffer[start];
  if (ch === '"') return consumeString(buffer, start);
  // Literal / number — walk to a delimiter.
  let j = start;
  while (j < buffer.length) {
    const c = buffer[j];
    if (c === "," || c === "}" || c === "]" || (c && /\s/.test(c))) break;
    j += 1;
  }
  if (j === start) return null;
  const token = buffer.slice(start, j);
  if (j < buffer.length) {
    // Token boundary reached — token must be a real literal.
    if (isLiteral(token)) {
      return { endIndex: j, complete: true };
    }
    return null;
  }
  // End-of-buffer mid-token: maybe complete (`true` exactly) or partial (`tru`).
  if (isLiteral(token)) {
    return { endIndex: j, complete: true };
  }
  return { endIndex: j, complete: false };
}

/**
 * The eight single-character escapes JSON permits after a backslash.
 * Anything else (`\q`, `\x`, …) is a malformed escape; `JSON.parse`
 * would reject the whole document, so we must too — but conservatively
 * (drop the bad string, keep prior committed fields) rather than by
 * nulling everything in the catch-all.
 */
const VALID_SINGLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/**
 * Consume a JSON string literal starting at the opening quote, validating
 * escape sequences as it goes (a backslash must introduce one of the eight
 * single-char escapes or a `\uXXXX` with four hex digits).
 *
 * Returns:
 * - `{ complete: true }` for a well-formed, closed string.
 * - `{ complete: false }` when the buffer *ends* mid-string or mid-escape
 *   (`"abc`, a dangling `\`, a truncated `\u12`) — i.e. it may still be
 *   streaming; the caller drops it and keeps everything before it.
 * - `null` for a *closed-form* malformed escape (`"\q"`, `"\uXYZW"`): the
 *   string is terminated yet invalid, so it can never become valid and the
 *   value must be dropped. Same drop-and-keep handling as `complete: false`
 *   in object/array contexts; both preserve already-committed siblings.
 */
function consumeString(buffer: string, start: number): { endIndex: number; complete: boolean } | null {
  if (buffer[start] !== '"') return null;
  for (let j = start + 1; j < buffer.length; j += 1) {
    const c = buffer[j];
    if (c === "\\") {
      const next = buffer[j + 1];
      // Dangling backslash at end of buffer — escape not yet transmitted.
      if (next === undefined) return { endIndex: buffer.length, complete: false };
      if (next === "u") {
        const hex = buffer.slice(j + 2, j + 6);
        // Fewer than 4 chars only when the buffer ran out — still streaming.
        if (hex.length < 4) return { endIndex: buffer.length, complete: false };
        // Four chars present but not all hex — closed-form malformed escape.
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        j += 5; // skip `uXXXX`; loop's +1 lands past the last hex digit
        continue;
      }
      if (!VALID_SINGLE_ESCAPES.has(next)) return null; // malformed escape (\q, \x, …)
      j += 1; // skip the escaped character
      continue;
    }
    if (c === '"') {
      return { endIndex: j + 1, complete: true };
    }
    // An unescaped control character (U+0000–U+001F: a literal newline, tab,
    // \x01, …) is invalid inside a JSON string; JSON.parse rejects the whole
    // document. Treat it as closed-form corruption (#52) — it can never become
    // valid by streaming more — and return null so the bad string is dropped
    // and prior committed siblings survive, the same drop-and-keep handling as
    // a malformed escape above. Without this the scanner reports complete:true,
    // the final JSON.parse throws, and the catch-all nulls EVERY field.
    if (c !== undefined && c.charCodeAt(0) < 0x20) return null;
  }
  return { endIndex: buffer.length, complete: false };
}

/**
 * Returns true if the slice is a complete JSON literal: a number,
 * `true`, `false`, or `null`. Strings are handled separately in the
 * scanner because they have explicit delimiters.
 */
function isLiteral(slice: string): boolean {
  if (slice === "true" || slice === "false" || slice === "null") return true;
  // Number: optional minus, digits, optional fractional, optional exponent.
  // Must not end with a `.` or `e`/`E` or sign-after-exp.
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(slice);
}
