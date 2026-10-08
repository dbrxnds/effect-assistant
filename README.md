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
| `Assistant.make`      | The definition. `yield* MyAssistant` gives `submit`, `subscribe`, `subscribeView`, `delete`.                         |
| `MyAssistant.toLayer` | The handler: what runs each turn, usually `turn.loop(...)`. It provides the assistant.                               |
| `turn.loop`           | The agent loop: model call, tool calls, repeat. The model talks to the user only through a `send_user_message` tool. |
| `AssistantEngine`     | Runs the chats: `layerMemory` in one process, `layerCluster` with one entity per chat.                               |
| `ChatLog`             | Stores each chat as an append-only log of events: `layerMemory`, or `layerSql`.                                      |

## Recipes

Each recipe changes the quick start. `MyAssistant`, `WeatherTools`, `WeatherToolsLive`, and `ModelLive` are as
above, and `instructions` is a prompt.

### A chat UI

```ts
const send = (chatId: ChatId.ChatId, inputId: InputId.InputId, text: string) =>
  MyAssistant.use((assistant) => assistant.submit(chatId, AssistantEvent.UserMessage.make({ id: inputId, text })))

const watch = (chatId: ChatId.ChatId, after?: number) =>
  Stream.unwrap(MyAssistant.useSync((assistant) => assistant.subscribeView(chatId, { after })))
```

- `subscribeView` streams the chat as the user sees it: messages, blocks, `activity`, `deleted`. The client
  folds it with `ChatView.apply`, from `ChatView.empty`.
- The client picks the `InputId`, so a retried send is stored once.
- Check the user may use the chat before calling either.

The demo does this over an Effect RPC WebSocket: [`packages/demo/shared/src/Rpc.ts`](./packages/demo/shared/src/Rpc.ts).

### Postgres and a cluster

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
  `AssistantEngine.layerCluster`. Its calls reach the runners that run the chats.

### Your chats, and deleting them

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

```ts
import { BlockKit, Decision } from "effect-assistant"

export const Shop = Assistant.make("shop", { blocks: BlockKit.make([Decision.block]) })

const OrderTools = Toolkit.make(
  Tool.make("place_order", {
    description: "Places an order.",
    parameters: Schema.Struct({ sku: Schema.String, quantity: Schema.Int }),
    success: Schema.Struct({ reference: Schema.String }),
    needsApproval: true // or a function of the params
  })
)

const ShopLive = Shop.toLayer((turn) => turn.loop({ instructions, toolkit: OrderTools })).pipe(
  Layer.provide(OrderTools.toLayer({ place_order: () => Effect.succeed({ reference: "R-1042" }) }))
)
```

The call waits until the user answers the decision block. Approved, it runs exactly as the model made it;
declined, it never runs. The view gives the client the paused call's `tool` and `params`.

### UI blocks

```tsx
const PickOne = Block.make("pick_one", {
  description: "Options to pick from, when the user chooses between a few.",
  props: Schema.Struct({ options: Schema.Array(Schema.String) }),
  answer: Schema.Struct({ picked: Schema.String })
})

const Blocks = BlockKit.make([PickOne, Decision.block])
export const MyAssistant = Assistant.make("my-assistant", { blocks: Blocks })

// In the client: a renderer per kind, checked by the type system.
const renderBlock = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
  pick_one: ({ props, open, respond }) =>
    props.options.map((option) => (
      <button key={option} disabled={!open} onClick={() => respond({ picked: option })}>
        {option}
      </button>
    )),
  decision: ({ props, open, respond }) => (
    <button disabled={!open} onClick={() => respond(Decision.answerAll(props, "approved"))}>
      Approve
    </button>
  )
})
```

### Specialists

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

The assistant hands a brief to a specialist, keeps chatting, and reads its report when it arrives.

### Skills and big tool catalogs

```ts
const reorder = Skill.make({
  name: "reorder",
  description: "Reordering something the user ordered before.",
  instructions: "1. Find their last order of it. 2. Confirm quantity and address. 3. Place it."
})

const Discovery = ToolDiscovery.make(AllOtherTools) // search_tools and execute_tool over a big toolkit

const MyAssistantLive = MyAssistant.toLayer((turn) =>
  turn.loop({ instructions, toolkit: Toolkit.merge(WeatherTools, Discovery.toolkit), skills: [reorder] })
).pipe(Layer.provide([WeatherToolsLive, Discovery.layer.pipe(Layer.provide(AllOtherToolsLive))]))
```

### Your own events

```ts
class ShipmentUpdated extends Schema.TaggedClass<ShipmentUpdated>()("ShipmentUpdated", {
  id: InputId.InputId,
  orderId: Schema.String,
  status: Schema.String
}) {}

export const MyAssistant = Assistant.make("my-assistant", {
  events: [
    AppEvent.make(ShipmentUpdated, {
      wakes: true, // starts a turn, like a message
      render: (update) => `<update>Order ${update.orderId} is ${update.status}. The user hasn't seen this.</update>`
    })
  ]
})

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

```ts
class Note extends Schema.TaggedClass<Note>()("Note", { text: Schema.String }) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [AppEvent.make(Note)] })

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
tool, uses `AssistantChat`: the same chat, untyped.

### Memory and long chats

```ts
class Summary extends Schema.TaggedClass<Summary>()("Summary", { text: Schema.String, throughSeq: Schema.Int }) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [AppEvent.make(Summary)] })

const MyAssistantLive = MyAssistant.toLayer(
  Effect.gen(function* () {
    const store = yield* Memory.MemoryStore // once per chat, from the layer

    return (turn) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const scopes = { personal: "user:42", shared: "team:7" } // from the chat's owner
          const remembered = Option.getOrElse(Memory.render(yield* Memory.facts(scopes), scopes), () => "")

          const compact = Effect.gen(function* () {
            const chat = yield* MyAssistant.Chat
            const entries = yield* chat.entries

            if (Compaction.inputTokens(entries) < 100_000) return

            const { text } = yield* LanguageModel.generateText({ prompt: `Summarize:\n\n${transcript(entries)}` })

            yield* chat.append(Summary.make({ text, throughSeq: entries.at(-1)?.seq ?? 0 }))
          })

          return Stream.concat(
            turn.loop({
              instructions: `${instructions}\n\n${remembered}`,
              toolkit: Toolkit.merge(WeatherTools, Memory.Tools), // remember, forget, recall
              history: Compaction.since(Schema.is(Summary)) // the last summary, then what came after
            }),
            Stream.drain(Stream.fromEffect(compact))
          ).pipe(Stream.provideService(Memory.CurrentScopes, scopes))
        })
      ).pipe(Stream.provideService(Memory.MemoryStore, store))
  })
).pipe(Layer.provide([WeatherToolsLive, Memory.layerTools]), Layer.provide(Memory.layerMemory))
```

`Memory.layerSql` stores facts in a `memory_facts` table. See [memory and long chats](./apps/docs/guide/memory.md).

### Tests

The engine only needs a `LanguageModel`. The library's own tests run on a scripted one,
[`test/utils/scripted.ts`](./packages/effect-assistant/test/utils/scripted.ts), so they need no API key.

## Docs

The [guides](./apps/docs/guide) cover each piece in depth, and the API reference is generated from the JSDoc:
`pnpm docs:dev`.

## This repository

| Path                        | What                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/effect-assistant` | The library.                                                                                    |
| `packages/demo/api`         | A demo server for a fictional company, Acme: tools, approvals, prompts, durable workflows, RPC. |
| `packages/demo/shared`      | What the demo's web app and API share: RPCs, UI blocks, ids, demo data.                         |
| `apps/web`                  | The demo's chat UI.                                                                             |
| `apps/docs`                 | The docs site.                                                                                  |

```bash
pnpm install
pnpm dev            # demo API on :8787 (in memory, or Postgres with DATABASE_URL), web on :3000
pnpm docs:dev       # docs on :5173
pnpm check          # format, lint, and type check
pnpm test           # on a scripted model, no API key needed
pnpm test:contract  # against a real model (ANTHROPIC_API_KEY in .env.local)
pnpm build
```
