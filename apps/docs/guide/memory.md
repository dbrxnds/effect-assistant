# Memory and long chats

Two modules for what outlives a single prompt. [`Memory`](/api/Memory) is
what the assistant remembers across chats. [`Compaction`](/api/Compaction)
lets one long chat read a summary instead of everything before it. Both are
optional: an assistant without them reads its whole chat, and remembers
nothing between chats.

## Memory across chats

A **fact** is one short sentence in a **scope**. A turn reads two scopes:
the user's own (`personal`) and, if there is one, their team's (`shared`).
The app picks the keys, so memory never crosses whatever line the app draws
(a company, a workspace).

| Kind      | What it is                                                    | Written by                      |
| --------- | ------------------------------------------------------------- | ------------------------------- |
| `profile` | Lasting: a preference, how they like to work.                 | The model, with `remember`      |
| `note`    | Short-lived context; expires (14 days unless the model says). | The model, with `remember`      |
| `log`     | One line per chat: what happened in it, for later chats.      | Your handler, with `Memory.log` |

The model gets three tools, `remember`, `forget`, and `recall` (search,
including older chat lines), as a native toolkit, `Memory.Tools`. Its
handlers are `Memory.layerTools`; they need the `MemoryStore`, and the
turn's scopes as `Memory.CurrentScopes`.

```ts
import { Memory } from "effect-assistant"
import * as Toolkit from "effect/ai/Toolkit"

const MyAssistantHandlers = MyAssistant.toLayer(
  Effect.gen(function* () {
    const owners = yield* ChatOwners // your service: whom a chat is for
    const store = yield* Memory.MemoryStore

    return (turn) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const user = yield* owners.forChat(turn.chatId)
          const scopes = { personal: `user:${user.id}`, shared: `team:${user.teamId}` }
          const facts = yield* Memory.facts(scopes).pipe(Effect.provideService(Memory.MemoryStore, store))
          const remembered = Option.getOrElse(Memory.render(facts, scopes), () => "")

          return turn
            .loop({
              instructions: `You help ${user.name}.\n\n${remembered}`,
              toolkit: Toolkit.merge(MyTools, Memory.Tools)
            })
            .pipe(Stream.provideService(Memory.CurrentScopes, scopes), Stream.provideService(Memory.MemoryStore, store))
        })
      )
  })
).pipe(Layer.provide([MyToolsLive, Memory.layerTools]))
```

`Memory.render` writes the facts as the model reads them: profile facts and
notes with their ids (so it can replace or forget one), and the newest log
lines, dated. `Memory.facts(scopes, { exceptLogOf: chatId })` leaves out this
chat's own log line.

**Keep the prompt stable.** Facts another chat writes would change this
chat's system prompt between turns, and a changed prompt starts the
provider's prompt cache over. The steadier pattern: when a chat starts,
store what it remembered as one of [your own events](./app-events), and put
it in the history with a `history` view. The chat then reads the same memory
until you choose to refresh it, for example after a summary.

**Storage.** `Memory.layerMemory` keeps facts in memory, for tests and local
runs. `Memory.layerSql` stores them with a `SqlClient`, in a table you
create:

```sql
CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  chat_id TEXT,
  at DOUBLE PRECISION NOT NULL,
  expires_at DOUBLE PRECISION
);
CREATE INDEX memory_facts_scope ON memory_facts (scope);
```

## Long chats: compaction

A long chat's prompt grows with every turn. Compaction stores a summary as
one of your events, and the model reads the summary in place of everything
it covers. The log keeps everything; the UI still shows the whole chat.

The library gives the pieces. When to compact, which model writes the
summary, and what it says are your app's:

- **A summary event**: your own tagged schema with `text` and `throughSeq`,
  the last `seq` it covers. Entries after `throughSeq` stay as they are, so
  a message that arrived while the summary was written isn't lost.
- **`Compaction.since(isSummary)`**: a history view that starts at the last
  summary. The model reads the summary, the files attached earlier (a
  summary may drop a file's id, and tools need it), and what's still open
  (blocks not answered, decisions waiting, specialists working), then the
  entries after it.
- **`Compaction.inputTokens(entries)`**: the last model call's input
  tokens, to decide when the prompt is big enough to compact.

```ts
import { AppEvent, AssistantChat, Compaction } from "effect-assistant"
import * as LanguageModel from "effect/ai/LanguageModel"

class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  text: Schema.String,
  throughSeq: Schema.Int
}) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [AppEvent.make(Summary)] })

const sinceSummary = Compaction.since(Schema.is(Summary))

const MyAssistantHandlers = MyAssistant.toLayer((turn) => {
  const compact = Effect.gen(function* () {
    const chat = yield* AssistantChat.AssistantChat
    const entries = yield* chat.entries

    if (Compaction.inputTokens(entries) < 100_000) return

    const response = yield* LanguageModel.generateText({
      prompt: `Summarize this chat for whoever picks it up:\n\n${transcript(entries)}` // transcript: yours
    })

    yield* chat.append(Summary.make({ text: response.text, throughSeq: entries.at(-1)?.seq ?? 0 }))
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("compaction failed", cause)))

  // After the reply, so the user doesn't wait for it; the next turn reads the summary.
  return Stream.concat(turn.loop({ instructions, history: sinceSummary }), Stream.drain(Stream.fromEffect(compact)))
})
```

A summary that failed to write changes nothing: the next turn reads the
whole chat, as before. A summary starts the prompt cache over anyway, so
it's the time to refresh anything else the chat reads once, like memory.
