# effect-assistant

A chat assistant on [Effect](https://effect.website) that works like a colleague: you message it, it works
in the background with your tools, and it messages you back. Messages you send while it works join the
turn that's running.

```bash
pnpm add effect-assistant effect@^4.0.0 @effect/ai-anthropic@^4.0.0
```

## Quick start

```ts
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"
import { Assistant, AssistantEngine, AssistantEvent, ChatId, ChatLog } from "effect-assistant"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

export const MyAssistant = Assistant.make("my-assistant")

const WeatherTools = Toolkit.make(
  Tool.make("get_weather", {
    description: "Current weather for a city.",
    parameters: Schema.Struct({ city: Schema.String }),
    success: Schema.String
  })
)

const WeatherToolsLive = WeatherTools.toLayer({
  get_weather: ({ city }) => Effect.succeed(`${city}: sunny, 21°C`)
})

const MyAssistantLive = MyAssistant.toLayer((turn) =>
  turn.loop({ instructions: "You help a small team. Be brief.", toolkit: WeatherTools })
).pipe(Layer.provide(WeatherToolsLive))

const ModelLive = AnthropicLanguageModel.model("claude-sonnet-5-5").pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

const AppLive = MyAssistantLive.pipe(
  Layer.provide(ModelLive),
  Layer.provideMerge(AssistantEngine.layerMemory),
  Layer.provideMerge(ChatLog.layerMemory)
)

const program = Effect.gen(function* () {
  const assistant = yield* MyAssistant
  const chatId = yield* ChatId.make()

  yield* assistant.submit(chatId, AssistantEvent.UserMessage.make({ text: "Weather in Oslo?" }))

  yield* assistant.subscribe(chatId).pipe(
    Stream.takeUntil(({ event }) => Predicate.isTagged(event, "TurnCompleted")),
    Stream.runForEach(({ event }) =>
      Predicate.isTagged(event, "AssistantMessage") ? Console.log(event.text) : Effect.void
    )
  )
})

Effect.runPromise(program.pipe(Effect.provide(AppLive)))
// Oslo is sunny, 21°C.
```

| Piece                 | What it is                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Assistant.make`      | The definition. `yield* MyAssistant` gives `submit`, `subscribe`, `delete`.                                          |
| `MyAssistant.toLayer` | The handler: what runs each turn, usually `turn.loop(...)`. It provides the assistant.                               |
| `turn.loop`           | The agent loop: model call, tool calls, repeat. The model talks to the user only through a `send_user_message` tool. |
| `AssistantEngine`     | Runs the chats: `layerMemory` in one process, `layerCluster` with one entity per chat.                               |
| `ChatLog`             | Stores each chat as an append-only log of events: `layerMemory`, or `layerSql`.                                      |

## How a turn works

1. **`submit` stores the input and returns.** The user's message is appended to the chat's log, and a turn
   starts in the background.
2. **The handler returns the turn as a stream.** `turn.loop(...)` is a `Stream` of what the loop does: a
   `ModelOutput` per model call, then a `ToolStarted` and a `ToolResult` per tool call. The engine writes each
   event to the log before it pulls the next, so a turn cut off by a crash picks up where it stopped.
3. **Every model call reads the log.** The model's history is rebuilt from the log before each call, so a
   message that arrives during a turn is read at its next step, or by a turn right after.
4. **The model talks only through a tool.** Its plain text never reaches the user. It sends a message by
   calling `send_user_message`, and ends its turn with `wait`. Tool output and the model's
   working notes stay out of the chat; the user sees only what it chose to say.
5. **Readers follow the log.** `subscribe` streams every event, for your server and tests. Piped through
   `Timeline.changes`, it streams the chat's timeline, what the user sees: messages, blocks, and whether something is
   working.

Because a turn is a stream, you change it with ordinary stream code: run something after the reply with
`Stream.concat`, provide services with `Stream.provideService`. Don't buffer it: events would run ahead of the
log.

The [turns guide](./apps/docs/guide/turns.md) has the details.

## Recipes

Each recipe changes the quick start. `MyAssistant`, `WeatherTools`, `WeatherToolsLive`, and `ModelLive` are as
above, and `instructions` is a prompt.

### A chat UI

Your server is the edge between users and chats: it checks the user may use a chat, then passes calls through.
The client gets the chat's timeline, never its log.

```ts
const send = (chatId: ChatId.ChatId, inputId: InputId.InputId, text: string) =>
  MyAssistant.use((assistant) => assistant.submit(chatId, AssistantEvent.UserMessage.make({ id: inputId, text })))

const watch = (chatId: ChatId.ChatId, after?: number) =>
  Stream.unwrap(
    MyAssistant.useSync((assistant) => assistant.subscribe(chatId).pipe(Timeline.changes(MyAssistant, { after })))
  )
```

- `Timeline.changes` turns the chat's log into its timeline, the chat as the user sees it: `items` (messages and
  blocks), `activity`, `deleted`. The client folds the changes with `Timeline.fold` (or `Timeline.apply`, from
  `Timeline.empty`).
- None of your own events reach the client unless the server names them:
  `Timeline.changes(MyAssistant, { show: [OrderPlaced] })`, with `Timeline.Change([OrderPlaced])` as the RPC's success
  schema (a handler that shows more than the schema names doesn't compile). Each one is an item typed with its event:
  its `_tag` is the event's and `event` is the event, so
  `Match.valueTags(item, { UserMessage, AssistantMessage, OrderPlaced: (placed) => placed.event })`.
- `after` goes to `Timeline.changes`, not to `subscribe`: the timeline is folded from the whole log, and only the
  changes up to `after` are skipped.
- The client picks the `InputId`, so a retried send is stored once.
- Check the user may use the chat before calling either.

The demo does this over an Effect RPC WebSocket: [`packages/demo/shared/src/Rpc.ts`](./packages/demo/shared/src/Rpc.ts).

### Postgres and a cluster

For production: the log goes to SQL, and each chat runs as an Effect Cluster entity, so chats survive restarts
and one process writes each chat.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as SingleRunner from "effect/cluster/SingleRunner"

const AppLive = MyAssistantLive.pipe(
  Layer.provide(ModelLive),
  Layer.provideMerge(AssistantEngine.layerCluster),
  Layer.provideMerge(
    Layer.merge(ChatLog.layerSql, SingleRunner.layer({ runnerStorage: "sql" }).pipe(Layer.provide(NodeCrypto.layer)))
  ),
  Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }))
)
```

```sql
CREATE TABLE chat_log (
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at DOUBLE PRECISION NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
```

- Each chat is a cluster entity: one writer, and a turn cut off by a crash resumes.
- A process that only serves clients provides `MyAssistant.layerClient` (the service, no handler) with
  `AssistantEngine.layerClusterClient`, which needs only `Sharding`, no `ChatLog`. Its calls reach the runners
  that run the chats.

### Your chats, and deleting them

A chat's record (its owner, its title, whether it was deleted) is your app's. `Chats` tells the assistant
which chats exist: you decide whether a chat is created up front, or on its first message.

```ts
import { Chats } from "effect-assistant"

const ChatsLive = Layer.effect(
  Chats.Chats,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      get: Effect.fn(function* (chatId: ChatId.ChatId) {
        const [row] = yield* sql<{ readonly deleted_at: number | null }>`
          SELECT deleted_at FROM chats WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie)

        if (row === undefined) return yield* new Chats.GetChatError({ chatId, reason: "NotFound" })
        if (row.deleted_at !== null) return yield* new Chats.GetChatError({ chatId, reason: "Deleted" })

        return { chatId }
      })
    }
  })
)

const deleteChat = (chatId: ChatId.ChatId) =>
  Effect.gen(function* () {
    yield* markDeleted(chatId) // your table
    yield* (yield* MyAssistant).delete(chatId)
  })
```

- Provide `ChatsLive` next to `ChatLog`. Without it, every chat exists from its first input.
- `get` is asked before `submit` sends (it fails with `GetChatError`), when an input is stored, and before
  every model call.
- `delete` appends a `ChatDeleted`, stops the turn and specialists, and ends subscribers' streams. The log
  stays.

### Ask before acting

Some things the assistant shouldn't do on its own, like placing an order. Make the tool with Effect's
`needsApproval`: the model's call doesn't run, the turn ends, and the chat's timeline shows the call for the user
to approve or reject, under the assistant's message saying what it asks. Their decision is an input; an approved call runs then, with the same id and idempotency
key, and the model reads its result.

```ts
const PlaceOrderParams = Schema.Struct({ sku: Schema.String, quantity: Schema.Int, total: Schema.Finite })

const PlaceOrder = Tool.make("place_order", {
  description: "Places an order. The user approves it first; say what you're asking them to approve.",
  parameters: PlaceOrderParams,
  success: Schema.Struct({ orderId: Schema.String }),
  needsApproval: true,
  dependencies: [AssistantToolCall.AssistantToolCall]
})

// The client: an item per call on the timeline, `{ _tag: "ToolApproval", id, tool, status, ... }`, only the yes
// or no. The assistant's message says what it asks.
submit(ToolApproval.approve(item)) // or ToolApproval.reject(item, { reason })
```

A call the user moves on from expires with `ToolApproval.closeStale({ messages: 10 })`, and the model reads that it
wasn't approved. A question for the user is a block with an `answer` schema. See
[involving the user](./apps/docs/guide/user-involvement.md).

### UI blocks

When a structured answer is easier than typing, the assistant can attach a block to a message: options, a
small input. The model fills in its props; the user's click comes back as an input, typed by the block's
`answer` schema. The user can always type instead.

```tsx
const PickOne = Block.make("pick_one", {
  description: "Options to pick from, when the user chooses between a few.",
  props: Schema.Struct({ options: Schema.Array(Schema.String) }),
  answer: Schema.Struct({ picked: Schema.String })
})

const Blocks = BlockKit.make([PickOne])
export const MyAssistant = Assistant.make("my-assistant", { blocks: Blocks })

// In the client: a renderer per kind, checked by the type system.
const renderBlock = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
  pick_one: ({ props, open, respond }) =>
    props.options.map((option) => (
      <button key={option} disabled={!open} onClick={() => respond({ picked: option })}>
        {option}
      </button>
    ))
})
```

### Specialists

A specialist is a focused agent the assistant hands slow work to, like a report. It runs in the background
with its own instructions and tools, while the assistant keeps chatting.

```ts
const Research = Specialist.make("research", { description: "Digs through past orders. Slow: runs in the background." })

const ResearchLive = Research.toLayer((run) =>
  run.loop({ instructions: "Answer in a few lines.", toolkit: ResearchTools })
).pipe(Layer.provide(ResearchToolsLive))

export const MyAssistant = Assistant.make("my-assistant", { specialists: [Research] })

const MyAssistantLive = MyAssistant.toLayer((turn) => turn.loop({ instructions, toolkit: WeatherTools })).pipe(
  Layer.provide([WeatherToolsLive, ResearchLive])
)
```

The assistant writes the specialist a brief, and reads its report when it arrives, as an event that starts a
turn. It decides what to tell the user, and can message or stop a run while it works.

### Skills and big tool catalogs

Both keep the prompt small. A skill is a playbook: `Skill.toolkit(skills)` is the `load_skill` tool, whose
description lists each skill's name and one line, and the model loads the steps when a task matches. Merge it into
the loop's toolkit and provide its `layer`. `ToolDiscovery` turns a big toolkit into two tools, `search_tools` and
`execute_tool`, so the model finds a tool when it needs one instead of reading every definition.

```ts
const reorder = Skill.make("reorder", {
  description: "Reordering something the user ordered before.",
  instructions: "1. Find their last order of it. 2. Confirm quantity and address. 3. Place it with place_order."
})

const Skills = Skill.toolkit([reorder]) // load_skill, with its catalog

const Discovery = ToolDiscovery.make(AllOtherTools) // search_tools and execute_tool over a big toolkit
const DiscoveryLive = ToolDiscovery.layer(AllOtherTools).pipe(Layer.provide(AllOtherToolsLive))

const MyAssistantLive = MyAssistant.toLayer((turn) =>
  turn.loop({ instructions, toolkit: Toolkit.merge(WeatherTools, Discovery, Skills) })
).pipe(Layer.provide([WeatherToolsLive, DiscoveryLive, Skills.layer]))
```

### Your own events

Background work reports into the chat with events of your own: a workflow's progress, a webhook. The
definition lists their schemas. An event that comes in through `submit` starts a turn, like a message; one a
turn appends itself never does. The model reads one as your history view maps it, and the user sees it only
if the assistant tells them, or you `show` it on the timeline.

```ts
class ShipmentUpdated extends Schema.TaggedClass<ShipmentUpdated>()("ShipmentUpdated", {
  id: InputId.InputId,
  orderId: Schema.String,
  status: Schema.String
}) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [ShipmentUpdated] })

// What the model reads: each update as a short note.
const shipments: Assistant.HistoryView<ShipmentUpdated> = (entries) =>
  entries.map((entry) =>
    entry.event instanceof ShipmentUpdated
      ? Prompt.userMessage({
          content: [
            Prompt.textPart({
              text: `<update>Order ${entry.event.orderId} is ${entry.event.status}. The user hasn't seen this.</update>`
            })
          ]
        })
      : entry
  )

const MyAssistantLive = MyAssistant.toLayer((turn) => turn.loop({ instructions, history: shipments }))

// From a webhook or a workflow. The keyed id makes a redelivery harmless.
const onShipment = (chatId: ChatId.ChatId, orderId: string, status: string) =>
  MyAssistant.use((assistant) =>
    assistant.submit(
      chatId,
      ShipmentUpdated.make({ id: InputId.fromKey(`shipment:${orderId}:${status}`), orderId, status })
    )
  )
```

### Code in a chat

Code outside a chat uses the assistant (`yield* MyAssistant`). Code inside one, the handler or a tool its
turns run, uses the chat itself: its entries, and a way to add to them.

```ts
class Note extends Schema.TaggedClass<Note>()("Note", { text: Schema.String }) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [Note] })

const NoteTools = Toolkit.make(
  Tool.make("note", {
    description: "Notes something about the chat.",
    parameters: Schema.Struct({ text: Schema.String }),
    success: Schema.String,
    dependencies: [MyAssistant.Chat] // the turn provides it
  })
)

const NoteToolsLive = NoteTools.toLayer({
  note: ({ text }) =>
    Effect.gen(function* () {
      const chat = yield* MyAssistant.Chat
      const notes = (yield* chat.entries).flatMap(({ event }) => (Predicate.isTagged(event, "Note") ? [event] : []))

      yield* chat.append(Note.make({ text })) // only this assistant's events and the library's type-check

      return `${notes.length + 1} notes`
    })
})
```

`MyAssistant.Chat` is typed with the assistant's events. Code that doesn't know the assistant, like a shared
tool, uses `CurrentChat`: the same chat, untyped.

### Memory

Facts the assistant keeps between chats, and through a long chat's summaries: preferences, standing
decisions, something short-lived like "out of office until Friday". The model keeps them with three tools,
`remember`, `forget`, and `recall`. Where they're stored, and who shares them, is your app's: you implement
the store, and every method gets the chat it's for.

```ts
// Yours: where facts live, and whose they are for a chat.
const MemoryStoreLive = Layer.succeed(Memory.MemoryStore, {
  facts: (chatId) => ...,               // the chat owner's unexpired facts
  remember: (chatId, { text, expiresAt, replaces }) => ...,  // returns the fact's id
  forget: (chatId, id) => ...,
  recall: (chatId, query) => ...
})

const MyAssistantLive = MyAssistant.toLayer(
  Effect.gen(function* () {
    const memory = yield* Memory.MemoryStore

    return (turn) =>
      Stream.unwrap(
        Effect.map(memory.facts(turn.chatId), (facts) =>
          turn.loop({
            instructions: `${instructions}\n\n${Memory.render(facts)}`,
            toolkit: Toolkit.merge(WeatherTools, Memory.Tools) // remember, forget, recall
          })
        )
      ).pipe(Stream.provideService(Memory.MemoryStore, memory))
  })
).pipe(Layer.provide([WeatherToolsLive, Memory.layerTools]), Layer.provide(MemoryStoreLive))
```

The facts go in the turn's instructions, each with its id, so the model can update or forget one. A fact
another chat keeps shows up from the next turn, and `recall` finds it right away. `Memory.layerMemory` is an
in-memory store for tests and local runs.

### Long chats

A long chat's prompt grows with every turn. Compaction stores a summary as one of your events, and the model
reads the summary in place of everything it covers. The log keeps everything, so the UI still shows the whole
chat. When to compact and what the summary says are yours.

```ts
class Summary extends Schema.TaggedClass<Summary>()("Summary", { text: Schema.String, throughSeq: Schema.Int }) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [Summary] })

const MyAssistantLive = MyAssistant.toLayer((turn) => {
  const compact = Effect.gen(function* () {
    const chat = yield* MyAssistant.Chat
    const entries = yield* chat.entries

    if (Compaction.inputTokens(entries) < 100_000) return

    const { text } = yield* LanguageModel.generateText({ prompt: `Summarize:\n\n${transcript(entries)}` })

    yield* chat.append(Summary.make({ text, throughSeq: entries.at(-1)?.seq ?? 0 }))
  })

  return Stream.concat(
    turn.loop({ instructions, history: Compaction.since(Schema.is(Summary)) }), // the last summary, then the rest
    Stream.drain(Stream.fromEffect(compact)) // after the reply, so the user doesn't wait
  )
})
```

See [memory and long chats](./apps/docs/guide/memory.md).

### Tests

The engine only needs a `LanguageModel`, so tests swap in a model that answers what you script. The library's own tests run on a scripted one,
[`test/utils/scripted.ts`](./packages/effect-assistant/test/utils/scripted.ts), so they need no API key.

## Docs

The [guides](./apps/docs/guide) cover each piece in depth, and the API reference is generated from the JSDoc:
`pnpm docs:dev`.

## This repository

| Path                        | What                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/effect-assistant` | The library.                                                                                                    |
| `packages/demo/api`         | A demo server for a fictional company, Acme: tools, orders placed from blocks, prompts, durable workflows, RPC. |
| `packages/demo/shared`      | What the demo's web app and API share: RPCs, UI blocks, ids, demo data.                                         |
| `apps/web`                  | The demo's chat UI.                                                                                             |
| `apps/docs`                 | The docs site.                                                                                                  |

```bash
pnpm install
pnpm dev            # demo API on :8787 (in memory, or Postgres with DATABASE_URL), web on :3000
pnpm docs:dev       # docs on :5173
pnpm check          # format, lint, and type check
pnpm test           # on a scripted model, no API key needed
pnpm test:contract  # against a real model (ANTHROPIC_API_KEY in .env.local)
pnpm build
```
