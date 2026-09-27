# Custom loops

An assistant's handler returns its turn as a stream: `turn.loop(...)` for the
usual loop, or any stream of the same events. A specialist's handler does the
same with `run.loop(...)`. Changing how an assistant works is changing that
stream.

`turn.loop` is built from pieces you can use yourself:

| Piece                                               | What it is                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `turn.instructions(text)`                           | The full system prompt: `Instructions.protocol`, your text, and the specialist runs working now. |
| `turn.tools`                                        | The assistant's own tools: `send_user_message`, `wait`, and the specialist tools.                |
| `turn.history(view?)`                               | The model's history from the chat's entries: all of them, or what a view keeps.                  |
| `turn.entries`                                      | The chat's entries, with the assistant's own events decoded.                                     |
| [`AssistantLoop.step`](/api/AssistantLoop#step)     | One step: call the model, run its tool calls.                                                    |
| [`AssistantLoop.stream`](/api/AssistantLoop#stream) | The whole loop, steps until the model is done.                                                   |
| `turn.replyIfOwed(...)`                             | One more pass, reply-only, when the user's latest message has no reply.                          |

`turn.loop` is `AssistantLoop.stream` with these wired in, the skill catalog,
and a tool call required at every step, followed by `turn.replyIfOwed`.

## A loop of your own

`AssistantLoop.step(options, then)` is one step, as a body for
`AssistantLoop.loop`. It calls the model (the `LanguageModel` in context) with
the current history and emits its `ModelOutput`, then runs the tool calls and
emits a `ToolStarted` and a `ToolResult` for each. `then` gets
`{ output, done }` and returns `AssistantLoop.next(state)` or
`AssistantLoop.stop()`. `done` means the model made no tool calls, or ended
its turn (`wait`, or a message with `wait: true`) and none of the step's
calls failed.

**Example** (At most 12 steps)

```ts
import { AssistantLoop } from "effect-assistant"
import * as Stream from "effect/Stream"

const instructions = "You help a small marketing team."

const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  AssistantLoop.loop({ steps: 0 }, (state) =>
    AssistantLoop.step(
      {
        instructions: turn.instructions(instructions),
        toolkit: AssistantLoop.merge(turn.tools, toolkit),
        history: turn.history(),
        toolChoice: "required"
      },
      (result) =>
        result.done || state.steps >= 12 ? AssistantLoop.stop() : AssistantLoop.next({ steps: state.steps + 1 })
    )
  ).pipe(Stream.concat(turn.replyIfOwed({ instructions })))
)
```

The loop's state is yours: step limits, budgets, anything `then` decides on.

- A step reads the history when it starts, so a message the user sends
  mid-turn is seen at the next step.
- A history with tool calls a crash cut off runs those first, with the same
  ids, instead of calling the model. `output` is then unset.
- The engine records each event before it pulls the next. Don't buffer the
  stream ahead (`Stream.buffer`) or run it twice.

## End with replyIfOwed

`turn.replyIfOwed({ instructions })` runs one more pass when the user's
latest message has no reply and nothing arrived after the loop's last read.
That pass can only call `send_user_message`. When no reply is owed, it's
empty. Pass it the same instructions as the loop; it adds `Instructions.protocol`
itself, and a nudge that it hasn't replied yet (`nudge` sets your own).

End a custom loop with `Stream.concat(turn.replyIfOwed(...))`. Without it, a
turn that never replies ends with `TurnFailed` ("I finished without sending a
reply."). See [a reply to every message](./turns#a-reply-to-every-message).

## Change what the model sees

A history view picks which of the chat's entries the model reads, and what
goes with them. It gets the entries and returns entries (the model reads them
as usual) and prompt messages (`effect/unstable/ai/Prompt`, which it reads as
they are), in order. Pass it to
the loop as `history`, or to `turn.history(view)` in a loop of your own.

**Example** (Keep the last 10 turns)

```ts
import { type Assistant, AssistantEvent } from "effect-assistant"

const lastTurns =
  (turns: number): Assistant.HistoryView =>
  (entries) => {
    const starts = entries.flatMap((entry, i) => (AssistantEvent.isTurnEnd(entry.event) ? [i + 1] : []))

    return entries.slice(starts.at(-turns) ?? 0)
  }

const MyAssistantHandlers = MyAssistant.toLayer((turn) => turn.loop({ instructions, history: lastTurns(10) }))
```

Cut the entries just after a turn ended: a turn closes its tool calls before
it ends, so every call keeps its result.

## Compaction

Instead of dropping the start of a long chat, summarize it. Store the summary
as an event of your own, and start the history at the last one.

Register the event with the assistant's `events` option (see
[your own events](./app-events)). `turn.append` writes it to the chat, and
`turn.entries` reads it back as a `Summary`. It doesn't wake a turn, and
with no `render` the model doesn't read it unless a view puts it in.

```ts
import { AppEvent, Assistant } from "effect-assistant"
import * as Schema from "effect/Schema"

class Summary extends Schema.TaggedClass<Summary>()("Summary", { text: Schema.String }) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [AppEvent.make(Summary)] })
```

The view starts at the last summary: its text first, then the entries after
it. When that grows past a size, the handler appends a new summary before it
runs the loop.

**Example** (Summarize past 200 messages)

```ts
import type { Assistant } from "effect-assistant"
import * as Effect from "effect/Effect"
import * as Prompt from "effect/unstable/ai/Prompt"

const sinceSummary: Assistant.HistoryView<Summary> = (entries) => {
  const last = entries.findLast(({ event }) => event instanceof Summary)

  return last === undefined || !(last.event instanceof Summary)
    ? entries
    : [
        ...Prompt.make(`Earlier in this chat: ${last.event.text}`).content,
        ...entries.filter(({ seq }) => seq > last.seq)
      ]
}

const MyAssistantHandlers = MyAssistant.toLayer(
  Effect.gen(function* () {
    const summarizer = yield* Summarizer // your service: summarizes a history

    return Effect.fn(function* (turn: Assistant.Turn<Summary>) {
      const history = yield* turn.history(sinceSummary)

      if (history.length > 200) yield* turn.append(Summary.make({ text: yield* summarizer.summarize(history) }))

      return turn.loop({ instructions, history: sinceSummary })
    })
  })
)
```

A new summary covers the earlier one, since the view puts it first. The full
log stays in the chat: the UI still shows everything.

## Change when it stops

The stream is an ordinary `Stream`, so its combinators work. Stop only between
steps, though. If the stream ends after a `ModelOutput` with tool calls and
before their results, the engine records a "not run" result for each call, so
the history stays valid, but the model sees its calls weren't run.
`AssistantLoop.step` never stops there: `then` runs after the step's tool
results.

## Services

A custom loop follows the same rule as `turn.loop`: it may use the turn's
services, `LanguageModel`, and what the build Effect required (see
[what a handler may use](./assistant#what-a-handler-may-use)). The
`Summarizer` above is yielded in the build Effect.
