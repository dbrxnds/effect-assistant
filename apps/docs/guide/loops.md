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
| `turn.history`                                      | The model's history, rebuilt from the chat's log each time you read it.                          |
| `turn.entries`                                      | The chat's entries, for a history of your own (see [below](#change-what-the-model-sees)).        |
| [`AssistantLoop.step`](/api/AssistantLoop#step)     | One step: call the model, run its tool calls.                                                    |
| [`AssistantLoop.stream`](/api/AssistantLoop#stream) | The whole loop, steps until the model is done.                                                   |
| `turn.replyIfOwed(...)`                             | One more pass, reply-only, when the user's latest message has no reply.                          |

`turn.loop` is `AssistantLoop.stream` with these wired in, the skill catalog,
and a tool call required at every step, followed by `turn.replyIfOwed`.

## A loop of your own

`AssistantLoop.step(options, then)` is one step, as a body for effect-uai's
`Loop.loop`. It calls the model with the current history and emits its
`ModelOutput`, then runs the tool calls and emits a `ToolStarted` and a
`ToolResult` for each. `then` gets `{ output, done }` and returns
`Loop.next(state)` or `Loop.stop()`. `done` means the model made no tool calls,
or called `wait`.

**Example** (At most 12 steps)

```ts
import * as Loop from "@effect-uai/core/Loop"
import { AssistantLoop } from "effect-assistant"
import * as Stream from "effect/Stream"

const instructions = "You help a small marketing team."

const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  Loop.loop({ steps: 0 }, (state) =>
    AssistantLoop.step(
      {
        model: "claude-sonnet-5",
        instructions: turn.instructions(instructions),
        toolkit: { ...turn.tools, ...toolkit },
        history: turn.history,
        toolChoice: "required"
      },
      (result) => (result.done || state.steps >= 12 ? Loop.stop() : Loop.next({ steps: state.steps + 1 }))
    )
  ).pipe(Stream.concat(turn.replyIfOwed({ model: "claude-sonnet-5", instructions })))
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

`turn.replyIfOwed({ model, instructions })` runs one more pass when the user's
latest message has no reply and nothing arrived after the loop's last read.
That pass can only call `send_user_message`. When no reply is owed, it's
empty. Pass it the same instructions as the loop; it adds `Instructions.protocol`
itself, and a nudge that it hasn't replied yet (`nudge` sets your own).

End a custom loop with `Stream.concat(turn.replyIfOwed(...))`. Without it, a
turn that never replies ends with `TurnFailed` ("I finished without sending a
reply."). See [a reply to every message](./turns#a-reply-to-every-message).

## Change what the model sees

Pass the loop a history of your own. `turn.entries` reads the chat's entries,
and [`AssistantHistory.fromEntries`](/api/AssistantHistory#fromentries) turns
any slice of them into the model's history, with the same rules as
`turn.history`.

**Example** (Keep the last 10 turns)

```ts
import { type Assistant, AssistantEvent, AssistantHistory, AssistantLoop } from "effect-assistant"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const lastTurns = (entries: ReadonlyArray<Assistant.Entry>, turns: number) => {
  const starts = entries.flatMap((entry, i) => (AssistantEvent.isTurnEnd(entry.event) ? [i + 1] : []))

  return entries.slice(starts.at(-turns) ?? 0)
}

const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  AssistantLoop.stream({
    model: "claude-sonnet-5",
    instructions: turn.instructions(instructions),
    toolkit: { ...turn.tools, ...toolkit },
    history: turn.entries.pipe(Effect.map((entries) => AssistantHistory.fromEntries(lastTurns(entries, 10)))),
    toolChoice: "required"
  }).pipe(Stream.concat(turn.replyIfOwed({ model: "claude-sonnet-5", instructions })))
)
```

Cut the entries just after a turn ended: a turn closes its tool calls before
it ends, so every call keeps its result.

## Compaction

Instead of dropping the start of a long chat, summarize it. Store the summary
as an event of your own, and start the history at the last one.

Declare the event with the assistant's `events` option. `turn.append` writes
it to the chat's log, and `turn.entries` reads it back as a `Summary`. The
model doesn't see it unless you put it in the history.

```ts
import { Assistant } from "effect-assistant"
import * as Schema from "effect/Schema"

class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  throughSeq: Schema.Int, // the last entry it covers
  text: Schema.String
}) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [Summary] })
```

The handler builds the history from the last summary on: the summary's text
first, then the entries after it. When that grows past a size, it appends a
new summary through the last turn end before it runs the loop.

**Example** (Summarize past 200 history items)

```ts
import * as Items from "@effect-uai/core/Items"
import { type Assistant, AssistantEvent, AssistantHistory, AssistantLoop } from "effect-assistant"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

/** The last summary, and the entries after it. */
const sinceSummary = (entries: ReadonlyArray<Assistant.Entry<Summary>>) => {
  const summary = entries.flatMap(({ event }) => (event instanceof Summary ? [event] : [])).at(-1)

  return { summary, since: entries.filter((entry) => entry.seq > (summary?.throughSeq ?? 0)) }
}

const historyOf = (entries: ReadonlyArray<Assistant.Entry<Summary>>) => {
  const { summary, since } = sinceSummary(entries)

  return AssistantHistory.fromEntries(since, {
    before: summary === undefined ? [] : [Items.userText(`Earlier in this chat: ${summary.text}`)]
  })
}

const MyAssistantHandlers = MyAssistant.toLayer(
  Effect.gen(function* () {
    const summarizer = yield* Summarizer // your service: summarizes a history

    return Effect.fn(function* (turn: Assistant.Turn<Summary>) {
      const entries = yield* turn.entries
      const { since } = sinceSummary(entries)
      const lastEnd = since.filter(({ event }) => !(event instanceof Summary) && AssistantEvent.isTurnEnd(event)).at(-1)

      if (lastEnd !== undefined && AssistantHistory.fromEntries(since).length > 200) {
        const text = yield* summarizer.summarize(historyOf(entries.filter((entry) => entry.seq <= lastEnd.seq)))
        yield* turn.append(Summary.make({ throughSeq: lastEnd.seq, text }))
      }

      return AssistantLoop.stream({
        model: "claude-sonnet-5",
        instructions: turn.instructions(instructions),
        toolkit: turn.tools,
        history: turn.entries.pipe(Effect.map(historyOf)),
        toolChoice: "required"
      }).pipe(Stream.concat(turn.replyIfOwed({ model: "claude-sonnet-5", instructions })))
    })
  })
)
```

The summary of a summarized chat includes the earlier summary, since
`historyOf` puts it first. The full log stays in the chat: the UI still shows
everything.

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
