# Custom loops

An assistant's handler returns its turn as a stream: `turn.run(...)` for the
usual loop, or any stream of the same events. A specialist's handler does the
same with `turn.run(...)`. Changing how an assistant works is changing that
stream.

`turn.run` is built from pieces you can use yourself:

| Piece                                           | What it is                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `turn.instructions(text)`                       | The full system prompt: `Instructions.protocol`, your text, and the specialist runs working now. |
| `turn.history(view?)`                           | The model's history from the chat's entries: all of them, or what a view keeps.                  |
| [`AssistantLoop.step`](/api/AssistantLoop#step) | One step: call the model, run its tool calls.                                                    |
| [`AssistantLoop.run`](/api/AssistantLoop#run)   | The whole loop, steps until the model is done.                                                   |
| `turn.replyIfOwed(...)`                         | One more pass, reply-only, when the user's latest message has no reply.                          |

`turn.run` is `AssistantLoop.run` with these wired in, the skill catalog,
and a tool call required at every step, followed by `turn.replyIfOwed`. In a
turn, `AssistantLoop.step` and `run` add the assistant's own tools
(`send_user_message`, `wait`, the specialist tools) to the toolkit you pass,
so a loop of your own can message the user. A specialist's run has none.

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
        toolkit: MyTools, // the assistant's own tools come with them
        history: turn.history(),
        toolChoice: "required"
      },
      (result) =>
        result.done || state.steps >= 12 ? AssistantLoop.stop() : AssistantLoop.next({ steps: state.steps + 1 })
    )
  ).pipe(Stream.concat(turn.replyIfOwed({ instructions })))
).pipe(Layer.provide(MyToolsLive))
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
as usual) and prompt messages (`effect/ai/Prompt`, which it reads as
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

const MyAssistantHandlers = MyAssistant.toLayer((turn) => turn.run({ instructions, history: lastTurns(10) }))
```

Cut the entries just after a turn ended: a turn closes its tool calls before
it ends, so every call keeps its result.

### Your own events

The model reads none of your [events](./app-events) by itself: the view maps
those it should read to prompt messages, and an app event's entry it leaves
in is dropped. A message stands where the event was, and waits like an input
for open calls' results and for the model's next read (see
[history order](./events#history-order)).

**Example** (A short note for the model when the daily budget ran out)

```ts
import { type Assistant, Compaction } from "effect-assistant"
import * as Prompt from "effect/ai/Prompt"
import * as Schema from "effect/Schema"

class DailyBudgetReached extends Schema.TaggedClass<DailyBudgetReached>()("DailyBudgetReached", {}) {}

const note = (text: string) => Prompt.userMessage({ content: [Prompt.textPart({ text })] })

const withBudgetNotes = (item: Assistant.Entry<Summary | DailyBudgetReached> | Prompt.Message) =>
  "event" in item && item.event instanceof DailyBudgetReached
    ? note("The user reached today's budget here; they were told, and you didn't run.")
    : item

const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.run({
    instructions,
    history: (entries) => Compaction.since(Schema.is(Summary))(entries).map(withBudgetNotes)
  })
)
```

## Compaction

To have a long chat read a summary instead of everything before it, use
`Compaction.since` as the loop's `history`. See
[memory and long chats](./memory#long-chats-compaction).

## Change when it stops

The stream is an ordinary `Stream`, so its combinators work. Stop only between
steps, though. If the stream ends after a `ModelOutput` with tool calls and
before their results, the engine records a "not run" result for each call, so
the history stays valid, but the model sees its calls weren't run.
`AssistantLoop.step` never stops there: `then` runs after the step's tool
results.

## Services

A custom loop follows the same rule as `turn.run`: it may use the turn's
services, `LanguageModel`, and what the build Effect required (see
[what a handler may use](./assistant#what-a-handler-may-use)). The
`Summarizer` above is yielded in the build Effect.
