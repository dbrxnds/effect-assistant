# Memory and long chats

Two modules for what outlives a single prompt. [`Memory`](/api/Memory) is
what the assistant remembers across chats. [`Compaction`](/api/Compaction)
lets one long chat read a summary instead of everything before it. Both are
optional: an assistant without them reads its whole chat, and remembers
nothing between chats.

## Memory across chats

Memory is facts the assistant keeps between chats, and through a long chat's
summaries: a preference, a standing decision, something short-lived like
"out of office until Friday". The model keeps them with three tools,
`Memory.Tools`:

| Tool       | What it does                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `remember` | Keeps a fact, one short sentence. `until` (a date) makes it short-lived; `replaces` updates one. |
| `forget`   | Drops a fact by its id.                                                                          |
| `recall`   | Searches the facts by their words, for what isn't shown up front.                                |

Where facts are kept, and who shares them, is your app's: it implements
`Memory.MemoryStore`. Every method gets the chat it's for, and your code
decides whose facts that means: the chat's user, their team, or anything
else.

```ts
import { Memory } from "effect-assistant"

const MemoryStoreLive = Layer.effect(
  Memory.MemoryStore,
  Effect.gen(function* () {
    const owners = yield* ChatOwners // yours: whom a chat is for

    return {
      facts: (chatId) => ..., // the owner's unexpired facts
      remember: (chatId, { text, expiresAt, replaces }) => ..., // returns the new fact's id
      forget: (chatId, id) => ..., // fails with a ToolFailure when there's no such fact
      recall: (chatId, query) => ... // the owner's facts that match, best first
    }
  })
)
```

The tools' handlers (`Memory.layerTools`) call the store with the chat they
run in. The model writes `until` as a `YYYY-MM-DD`; the tool turns it into a
`DateTime.Utc` for the store, or tells the model it can't read it.

Show the facts in the turn's instructions with `Memory.render`, which lists
them with their ids so the model can replace or forget one:

```ts
const MyAssistantLive = MyAssistant.toLayer(
  Effect.gen(function* () {
    const memory = yield* Memory.MemoryStore

    return (turn) =>
      Stream.unwrap(
        Effect.map(memory.facts(turn.chatId), (facts) =>
          turn.loop({
            instructions: `${instructions}\n\n${Memory.render(facts)}`,
            toolkit: Toolkit.merge(MyTools, Memory.Tools)
          })
        )
      ).pipe(Stream.provideService(Memory.MemoryStore, memory))
  })
).pipe(Layer.provide([MyToolsLive, Memory.layerTools]), Layer.provide(MemoryStoreLive))
```

A fact another chat keeps is in this chat's instructions from its next turn,
and `recall` finds it right away. When the facts change, the instructions
change, and the provider's prompt cache starts over for that turn: facts
change rarely, so that's a small cost.

Don't keep what your tools can look up (orders, budgets, people): the
`remember` tool's description tells the model so. A line per earlier chat
("asked about Q4 budgets") is a fact your own code can keep in the store,
after a turn.

`Memory.layerMemory` is a store in memory, one set of facts for every chat,
for tests and local runs.

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
  (blocks not answered, specialists working), then the
  entries after it.
- **`Compaction.inputTokens(entries)`**: the last model call's input
  tokens, to decide when the prompt is big enough to compact.

```ts
import { Compaction } from "effect-assistant"
import * as LanguageModel from "effect/ai/LanguageModel"

class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  text: Schema.String,
  throughSeq: Schema.Int
}) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [Summary] })

const sinceSummary = Compaction.since(Schema.is(Summary))

const MyAssistantHandlers = MyAssistant.toLayer((turn) => {
  const compact = Effect.gen(function* () {
    const chat = yield* MyAssistant.Chat // typed with its events
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

The summary is for the model: the turn appends it, so it wakes no turn, and
leave it out of what the chat client gets (see [the chat client](./client)).
A summary that failed to write changes nothing: the next turn reads the
whole chat, as before. A summary starts the prompt cache over anyway, so
it's the time to refresh anything else the chat reads once, like memory.
