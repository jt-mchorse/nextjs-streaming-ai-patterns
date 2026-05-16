# Tool-use state machine

The tool-use streaming pattern (#2) is a small explicit state machine
that the client component (`components/tool-use-client.tsx`) walks as
SSE events arrive. Documenting it here keeps the implementation honest
and gives reviewers something concrete to push back against.

## States

| State            | Meaning                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `idle`           | Initial / terminal. No active stream.                                 |
| `connecting`     | `fetch('/api/tool-use')` in flight; awaiting first byte.              |
| `streaming_text` | Receiving `text_delta` events; before-tool-call text.                 |
| `tool_called`    | `tool_use_start` arrived; the tool's args are streaming in.          |
| `tool_running`   | `tool_use_stop` arrived; "tool is executing" — UI shows spinner state. |
| `tool_completed` | `tool_result` arrived; UI shows the tool result alongside the call.   |
| `done`           | Terminal. `message_stop` with `stop_reason: "end_turn"`.              |
| `interrupted`    | Terminal. Either `message_stop` with `stop_reason: "interrupted"`, or the local `AbortController.abort()` resolved the fetch with an `AbortError`. |
| `error`          | Terminal. Any thrown exception, non-200 response, or `event: error` frame. |

## Transitions

```
idle ──Run──▶ connecting

connecting ──text_delta──▶ streaming_text
connecting ──tool_use_start──▶ tool_called

streaming_text ──tool_use_start──▶ tool_called
streaming_text ──message_stop(end_turn)──▶ done

tool_called ──tool_use_delta──▶ tool_called (self-loop; partial JSON accumulates)
tool_called ──tool_use_stop──▶ tool_running

tool_running ──tool_result──▶ tool_completed

tool_completed ──text_delta──▶ streaming_text (post-tool tokens)
tool_completed ──message_stop(end_turn)──▶ done

<any non-terminal> ──message_stop(interrupted)──▶ interrupted
<any non-terminal> ──AbortController.abort()──▶ interrupted
<any state>        ──event:error / HTTP non-200 / throw──▶ error

done / interrupted / error ──Run──▶ connecting   (re-run resets the timeline)
```

## Interrupt semantics (D-007)

Interruption is a single `AbortController` propagated through three
layers:

1. **Client.** The UI's "Interrupt" button calls
   `controllerRef.current?.abort()`. The in-flight `fetch` rejects
   with an `AbortError`; the reader loop terminates.
2. **Route handler.** Next.js exposes the client's abort on
   `req.signal`. The handler passes it to `mockToolStream({ signal })`.
3. **Stream source.** `mockToolStream` checks `signal.aborted` at
   every yield boundary; on abort it yields a final
   `message_stop` with `stop_reason: "interrupted"` and returns.
   `sleep()` also honors the signal so the stream doesn't wait out
   its remaining jitter.

The result on the client: a *clean transcript* up through the last
event that arrived before the abort, plus a terminal `interrupted`
phase indicator. No partial frames, no broken-pipe errors, no
`Promise rejection` console noise.

## Why a state machine (and not just `boolean isStreaming`)

The states differ in what the UI should show and what events are
legal next. A flat `streaming` flag would still need to track
"are we showing the tool call card?", "is the tool result here yet?",
"did this complete or interrupt?". The state machine names those
distinctions explicitly so a regression in the renderer (e.g., the
tool card hiding after the tool result arrives) shows up as a
diff against the transition table, not as an off-by-one in
implicit branching.
