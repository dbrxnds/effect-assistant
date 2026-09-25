# The event log

Every chat is an append-only log of [`AssistantEvent`](/api/AssistantEvent)s.
The chat UI renders it, and the model's history is rebuilt from it before
every model call.

**Example** (Print a chat's log)

```ts
import * as Console from "effect/Console"
import * as Stream from "effect/Stream"

MyAssistant.subscribe(chatId).pipe(
  Stream.runForEach(({ seq, event }) => Console.log(seq, event._tag))
)
// 1 UserMessage
// 2 TurnStarted
// 3 ModelOutput
// …
```

Each event is stored as an `AssistantEvent.Entry`: the chat id, a `seq`
(1, 2, 3, … with no gaps), the time it was stored (`at`), and the `event`.

## Events

| Event                                        | Meaning                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `UserMessage`                                | Text the user typed.                                                                                              |
| `BlockAnswer`                                | The user used a [block](./blocks).                                                                                |
| `Fact`                                       | Something the assistant should know that the user didn't type: a workflow step, a specialist's answer, a webhook. |
| `AssistantMessage`                           | A message the assistant sent, optionally with a block.                                                            |
| `ModelOutput`, `ToolStarted`, `ToolResult`   | What the model did in each step, then each tool call as it starts and its result.                                 |
| `TurnStarted`, `TurnCompleted`, `TurnFailed` | [Turn](./turns) bookkeeping.                                                                                      |
| `SpecialistStarted`, `SpecialistFinished`    | A [specialist](./specialists) run working, and done; a finished run's report wakes a turn.                        |
| `BlocksClosed`                               | [Blocks](./blocks) closed without an answer.                                                                      |
| `Custom`                                     | An event of [your own](#your-own-events), like a summary.                                                         |

The first three are **inputs**: submitting one starts a turn, or joins the
one that is running. A chat client may submit `UserMessage` and
`BlockAnswer` (`AssistantEvent.ClientInput`); facts come from your server,
which submits them itself.

## Input ids make retries safe

Every input has an id, and a chat stores an input once per id: a resubmitted
id is ignored. A client can retry a message with the same id, and a
workflow step or a webhook that runs twice doesn't tell the assistant twice.

Use `InputId.make()` for a new random id, or derive one from what the input
stands for when that's stable:

```ts
InputId.make(`${orderId}:shipped`)
```

## Reading a chat

- `MyAssistant.subscribe(chatId)` streams stored entries, then live ones. It goes
  through the engine, so it works with the cluster engine too. Use it for a
  chat UI.
- The `ChatLog` service's `read(chatId)` returns what's stored
  now. Use it in tests, or in code that runs where the log is written.

`AssistantEvent` has helpers for common reads: `assistantTexts(entries)` for
what the user was shown, `isInput`, and `isTurnEnd`.

## Storage

The log is the `ChatLog` service:

- `ChatLog.layerMemory` keeps chats in memory, for tests and local
  runs.
- `ChatLog.layerSql` stores them with a `SqlClient`, in a
  `chat_log` table it creates if it doesn't exist.

Each chat writes its log one append at a time, so a turn and a specialist
run writing at once get entries in order. The `ChatLog` a handler, tool, or
run gets is its chat's, with that lock built in, and its entries go to the
chat's subscribers. Nothing locks across processes: one process writes each
chat (see [engines](./engines)). Code that writes a chat with the base
`ChatLog` outside its engine, like a test, should be its only writer.

## What is working

Turns and specialist runs each open with one event and close with another,
and an input is open until a turn that read it ends.
[`AssistantActivity`](/api/AssistantActivity) folds the log into what is open,
for a working indicator:

```ts
import { AssistantActivity } from "effect-assistant"

const activity = AssistantActivity.fromEntries(entries)

AssistantActivity.isWorking(activity) // a turn, one about to start, or a specialist run
activity.specialists // which specialists, since when
```

A client that folds the stream one entry at a time uses
`AssistantActivity.apply`. A workflow waiting on an approval or a timer isn't
working: the assistant took its last step, and the workflow's next fact wakes
it.

## Your own events

An assistant can store events of its own in the chat's log, like a summary
for [compaction](./loops#compaction). Declare them as tagged schemas:

```ts
class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  throughSeq: Schema.Int,
  text: Schema.String
}) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [Summary] })
```

In the handler, `turn.append(Summary.make({ ... }))` stores one as a `Custom`
entry (its `name` and encoded `value`), and `turn.entries` reads it back
decoded, as a `Summary`. The model doesn't see these events unless the
handler puts them in the history.

## History order

The model's history is rebuilt from the log, with two rules that keep it
coherent when things arrive mid-step:

- An input that arrives while tool calls are open waits until their results
  are in, so every tool call is directly followed by its output.
- An input that arrives while the model is writing a step is placed after
  that step (`ModelOutput.seenThroughSeq` records how far the model had read),
  so the model doesn't read its own reply as an answer to a message it never
  saw.

Facts appear in the history as `<fact source="…">…</fact>`.
