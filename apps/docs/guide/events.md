# The event log

Every chat is an append-only log of [`AssistantEvent`](/api/AssistantEvent)s.
A chat client gets what its user sees of it (its [view](./client)), and the
model's history is rebuilt from it before every model call.

**Example** (Print a chat's log)

```ts
import * as Console from "effect/Console"
import * as Stream from "effect/Stream"

const printLog = (chatId: ChatId.ChatId) =>
  MyAssistant.use((assistant) =>
    assistant.subscribe(chatId).pipe(Stream.runForEach(({ seq, event }) => Console.log(seq, event._tag)))
  )
// 1 UserMessage
// 2 TurnStarted
// 3 ModelOutput
// …
```

Each event is stored as an `AssistantEvent.Entry`: the chat id, a `seq`
(1, 2, 3, … with no gaps), the time it was stored (`at`), and the `event`.

## Events

| Event                                        | Meaning                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `UserMessage`                                | Text the user typed.                                                                                                     |
| `BlockAnswer`                                | The user used a [block](./blocks).                                                                                       |
| `AssistantMessage`                           | A message the assistant sent, optionally with a block.                                                                   |
| `ModelOutput`, `ToolStarted`, `ToolResult`   | The assistant's own work, which the user doesn't see: each model step, then each tool call as it starts, and its result. |
| `TurnStarted`, `TurnCompleted`, `TurnFailed` | [Turn](./turns) bookkeeping.                                                                                             |
| `SpecialistStarted`, `SpecialistFinished`    | A [specialist](./specialists) run working, and done; a finished run's report wakes a turn.                               |
| `BlocksClosed`                               | [Blocks](./blocks) closed without an answer.                                                                             |
| `DecisionRequested`, `DecisionResolved`      | A [decision](./decisions) the user is asked to make for a parked call, and how they decided.                             |
| `ChatDeleted`                                | The chat was [deleted](./chats#deleting-a-chat): nothing is stored after it.                                             |
| Your own events                              | [Yours](./app-events), like a workflow's progress or a summary, stored as themselves.                                    |

A `ModelOutput` is one model call: its response parts (text, reasoning, and
tool calls, as `effect/ai`'s `Response` parts), the model, the
provider's response id, the tokens it used (with the cache's reads and
writes), and how long it took. A `ToolResult` is a call's `outcome`
(`"success"` or `"failure"`), its `result` in JSON, and a failure's `kind`.
`TurnStarted` has the turn's trace id when a tracer records it, to go from
the log to the trace.

The first two are **inputs**: submitting one starts a turn, or joins the
one that is running. So is a `SpecialistFinished`, and each of your events
registered with `wakes: true`. A chat
client may submit `UserMessage` and `BlockAnswer`
(`AssistantEvent.UserInput`); your events come from your server, which
submits them itself.

## Input ids make retries safe

Every input has an id, and a chat stores an input once per id: a resubmitted
id is ignored. A client can retry a message with the same id, and a
workflow step or a webhook that runs twice doesn't tell the assistant twice.

Use `InputId.make()` for a new random id (an Effect, from Effect's `Random`),
or `InputId.fromKey` with what the input stands for when that's stable:

```ts
InputId.fromKey(`${orderId}:shipped`)
```

## Reading a chat

- The assistant's `subscribeView(chatId)` streams what the chat's user sees, for a
  [chat client](./client). It never has the assistant's own work.
- Its `subscribe(chatId)` streams the whole log: stored entries, then
  live ones, with your events decoded. It goes through the engine, so it
  works with the cluster engine too. It's for server-side code, tests, and
  debugging, not for a client. A reader that reconnects passes the last
  `seq` it has, `subscribe(chatId, { after: seq })`, and gets only what's
  new.
- An open chat keeps its entries in memory: turns and tools read them with
  `AssistantChat`'s `entries`, not from the log.
- The `ChatLog` service's `read(chatId)` (or `read(chatId, { after })`) returns
  what's stored now. Use it in tests, or in code that runs where the log is written.

`AssistantEvent` has helpers for common reads: `assistantTexts(entries)` for
what the user was shown, `isInput`, and `isTurnEnd`.

## Storage

The log is the `ChatLog` service:

- `ChatLog.layerMemory` keeps chats in memory, for tests and local
  runs.
- `ChatLog.layerSql` stores them with a `SqlClient`, in a `chat_log` table
  you create:

```sql
CREATE TABLE chat_log (
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at DOUBLE PRECISION NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
```

Entries are never removed. A deleted chat's log ends with a `ChatDeleted`,
and nothing is stored after it (see [deleting a chat](./chats#deleting-a-chat)).

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

Server-side code that folds the log one entry at a time uses
`AssistantActivity.apply`; pass `{ wakes }`, the tags of your events that
wake a turn, so they count as inputs. A chat client gets the same from its
[view](./client)'s `activity`. A workflow waiting on a timer
isn't working: the assistant took its last step, and the workflow's next
event wakes it.

## Your own events

An assistant stores events of its own in the chat, registered with
`AppEvent.make(schema, { wakes, render })`: what background work reports,
which wakes a turn, or the app's bookkeeping, which doesn't. Each is stored
as itself, in its schema's JSON form, and `AssistantChat`'s `entries` and
the assistant's `subscribe` decode it to its type. See
[your own events](./app-events). For an RPC that streams the log to other
server code, `MyAssistant.Entry` is the schema: it covers the assistant's
own events too.

## History order

The model's history is rebuilt from the log, with two rules that keep it
coherent when things arrive mid-step:

- An input that arrives while tool calls are open waits until their results
  are in, so every tool call is directly followed by its output.
- An input that arrives while the model is writing a step is placed after
  that step (`ModelOutput.seenThroughSeq` records how far the model had read),
  so the model doesn't read its own reply as an answer to a message it never
  saw.

Your events appear in the history as their `render` says, placed like inputs.
