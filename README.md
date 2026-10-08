# effect-assistant

A chat assistant on [Effect](https://effect.website) that behaves like a
colleague, not a request/response chatbot. You send it a message and it
works in the background. It uses tools, hands slow work to specialists,
waits for your approval when it should, and messages you when it has
something to say. A message you send while it works is picked up at its
next step.

- **One log per chat.** Every message, model call, tool result, and
  workflow update is an event in an append-only log. The model's prompt
  is rebuilt from it before every call, and the chat UI gets its own
  view of it.
- **It decides what you hear.** The model talks to the user only through a
  `send_user_message` tool. Its plain text, tool calls, and results stay
  its own work.
- **Interruptible.** `submit` returns at once. A message that arrives
  mid-turn joins the running turn.
- **Native Effect AI.** Any `LanguageModel` provider (`@effect/ai-anthropic`,
  ...), and plain `Tool`s and `Toolkit`s from `effect/ai`.
- **In memory or on a cluster.** Run it in one process for tests and local
  development. In production, run one cluster entity per chat, where a turn
  cut off by a crash resumes.

## Install

`effect` is a peer dependency. Add a model provider for `effect/ai`; this
README uses Anthropic.

```bash
pnpm add effect-assistant effect@^4.0.0 @effect/ai-anthropic@^4.0.0
```

## The simplest setup

One assistant with one tool. Everything is in memory, and the only setting
is `ANTHROPIC_API_KEY`.

```ts
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"
import {
  Assistant,
  AssistantEngine,
  AssistantEvent,
  AssistantLoop,
  ChatId,
  ChatLog,
  ChatView,
  InputId
} from "effect-assistant"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

// 1. The definition. Your server and UI import it to submit and subscribe.
export const MyAssistant = Assistant.make("my-assistant")

// 2. A native Effect tool, with its handler.
const GetWeather = Tool.make("get_weather", {
  description: "Current weather for a city.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ city: Schema.String, weather: Schema.String })
})

const toolkit = AssistantLoop.fromToolkit(Toolkit.make(GetWeather), {
  get_weather: ({ city }) => Effect.succeed({ city, weather: "sunny, 21°C" })
})

// 3. The handler. Every turn runs the agent loop.
const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({ instructions: "You help a small team. Be brief.", toolkit })
)

// 4. The model the loop calls. Any LanguageModel works.
const ModelLive = AnthropicLanguageModel.model("claude-sonnet-5-5").pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

// 5. The engine runs the chats and stores each one in a log. Both are in memory here.
const AppLive = MyAssistantHandlers.pipe(
  Layer.provide(ModelLive),
  Layer.provideMerge(AssistantEngine.layerMemory),
  Layer.provideMerge(ChatLog.layerMemory)
)

const program = Effect.gen(function* () {
  const chatId = yield* ChatId.make

  // Returns at once. The assistant works in the background.
  yield* MyAssistant.submit(
    chatId,
    AssistantEvent.UserMessage.make({ id: yield* InputId.make, text: "What's the weather in Oslo?" })
  )

  // The chat as its user sees it, until the assistant is done.
  const view = yield* MyAssistant.subscribeView(chatId).pipe(
    Stream.scan(() => ChatView.empty, ChatView.apply),
    Stream.takeUntil((view) => view.messages.length > 1 && ChatView.isIdle(view)),
    Stream.runLast
  )

  if (Option.isSome(view)) {
    for (const message of view.value.messages) yield* Console.log(`${message._tag}: ${message.text}`)
  }
})

Effect.runPromise(program.pipe(Effect.provide(AppLive)))
// UserMessage: What's the weather in Oslo?
// AssistantMessage: It's sunny in Oslo, 21°C.
```

Every assistant has the same three parts:

| Part           | What it is                                                                                |
| -------------- | ----------------------------------------------------------------------------------------- |
| **Definition** | `Assistant.make(name, options)`. Callers use its `submit`, `subscribeView`, and `delete`. |
| **Handler**    | `MyAssistant.toLayer(...)`. It runs each turn, usually `turn.loop(...)`.                  |
| **Engine**     | `AssistantEngine.layerMemory` or `layerCluster`, on top of a `ChatLog`.                   |

`subscribeView` is what a chat client should get: messages, their blocks,
and whether the assistant is working. `subscribe` streams the whole log,
including model calls and tool results, and is meant for server code and
tests.

## Going further

Each section below adds one thing to the simplest setup. They combine
freely. The code is trimmed to what changes. `instructions`, `toolkit`, and
`ModelLive` are the ones from above. The [docs](./apps/docs/guide) cover each
topic in depth.

### Keep chats in Postgres and survive restarts

Swap the memory log for `ChatLog.layerSql` and the memory engine for
`AssistantEngine.layerCluster`. Each chat becomes a cluster entity, so one
process writes it, and a persisted `submit` survives a crash.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as PgClient from "@effect/sql-pg/PgClient"
import { AssistantEngine, ChatLog } from "effect-assistant"
import * as SingleRunner from "effect/cluster/SingleRunner"
import * as SqlClient from "effect/sql/SqlClient"

// Where your app records that a chat was deleted, here a column on its own chats table.
const DeletedChatsLive = Layer.effect(
  ChatLog.DeletedChats,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return ChatLog.DeletedChats.of({
      isDeleted: (chatId) =>
        sql`SELECT 1 FROM chats WHERE chat_id = ${chatId} AND deleted_at IS NOT NULL`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie
        ),
      markDeleted: (chatId, at) =>
        sql`UPDATE chats SET deleted_at = ${at} WHERE chat_id = ${chatId} AND deleted_at IS NULL`.pipe(
          Effect.asVoid,
          Effect.orDie
        )
    })
  })
)

export const AppLive = MyAssistantHandlers.pipe(
  Layer.provide(ModelLive),
  // One cluster entity per chat.
  Layer.provideMerge(AssistantEngine.layerCluster),
  Layer.provideMerge(
    Layer.merge(
      ChatLog.layerSql.pipe(Layer.provide(DeletedChatsLive)),
      SingleRunner.layer({ runnerStorage: "sql" }).pipe(Layer.provide(NodeCrypto.layer))
    )
  ),
  // One pool for the log, the cluster's messages, and your own tables.
  Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }))
)
```

The library creates no tables. Create the log's table yourself:

```sql
CREATE TABLE chat_log (
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at DOUBLE PRECISION NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
```

With several processes, use a multi-runner cluster in place of
`SingleRunner`. `layerMemory` assumes one process. See
[deploying](./apps/docs/guide/deploying.md) and
[engines](./apps/docs/guide/engines.md).

### Serve a chat client

Whom a chat belongs to is your app's data. At the edge, check that the
signed-in user may use the chat, then pass the call through:

```ts
// The client makes the InputId, so a retried send is stored once.
const send = (chatId: ChatId.ChatId, inputId: InputId.InputId, text: string) =>
  MyAssistant.submit(chatId, AssistantEvent.UserMessage.make({ id: inputId, text }))

// A client that already has the view up to some seq passes it as `after`.
const watch = (chatId: ChatId.ChatId, after?: number) => MyAssistant.subscribeView(chatId, { after })
```

On the client, fold the updates with `ChatView.apply` starting from
`ChatView.empty`. Show a working indicator while `view.activity` says
something is working. `MyAssistant.delete(chatId)` removes the log, stops
whatever is running in the chat, and ends its subscribers. The demo serves
all of this over an Effect RPC WebSocket (`packages/demo/shared/src/Rpc.ts`).
See [the chat client](./apps/docs/guide/client.md) and
[chats and users](./apps/docs/guide/chats.md).

### Ask before acting: decisions

A tool with Effect's `needsApproval` doesn't run when the model calls it.
The call waits, with a preview, until the user approves or declines it in a
decision block. Only that answer runs the call.

```ts
import { BlockKit, Decision } from "effect-assistant"

// An assistant with such a tool needs the decision block.
export const Shop = Assistant.make("shop", { blocks: BlockKit.make([Decision.block]) })

const PlaceOrder = Tool.make("place_order", {
  description: "Places an order.",
  parameters: Schema.Struct({ sku: Schema.String, quantity: Schema.Int }),
  success: Schema.Struct({ reference: Schema.String }),
  needsApproval: true // or a function of the params
})

const orders = AssistantLoop.fromToolkit(
  Toolkit.make(PlaceOrder),
  { place_order: () => Effect.succeed({ reference: "R-1042" }) },
  // What the user sees before they decide.
  { previews: { place_order: ({ sku, quantity }) => Effect.succeed({ sku, quantity, total: quantity * 2.5 }) } }
)

const ShopHandlers = Shop.toLayer((turn) => turn.loop({ instructions, toolkit: orders }))
```

Running work can ask too. Inside an Effect workflow, `Decision.durable`
suspends until the user answers, across restarts. Provide a
`WorkflowEngine`, such as `ClusterWorkflowEngine.layer`.

```ts
const outcome =
  yield *
  Decision.durable(Shop, {
    chatId,
    name: "publish",
    source: "workflow:Publish",
    preview: post
  })

if (outcome === "declined") return
```

Outside a workflow, use `Decision.request` and then `Decision.outcome`. See
[decisions](./apps/docs/guide/decisions.md).

### UI blocks in messages

When a structured answer is easier than typing, the assistant can attach a
block to a message. The model fills in the props, and the user's answer
comes back as an input.

```ts
import { Block, BlockKit, Decision } from "effect-assistant"

const PickOne = Block.make("pick_one", {
  description: "Options to pick from, when the user chooses between a few.",
  props: Schema.Struct({ options: Schema.Array(Schema.String) }),
  answer: Schema.Struct({ picked: Schema.String })
})

export const Blocks = BlockKit.make([PickOne, Decision.block])
export const MyAssistant = Assistant.make("my-assistant", { blocks: Blocks })
```

On the client, `BlockKit.toClient` checks that every kind has a renderer:

```tsx
const renderBlock = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
  pick_one: ({ props, open, respond }) =>
    props.options.map((option) => (
      <button key={option} disabled={!open} onClick={() => respond({ picked: option })}>
        {option}
      </button>
    )),
  decision: ({ props, open, decisions, respond }) => (
    <div>
      {decisions.map((decision) => (
        <pre key={decision.id}>{JSON.stringify(decision.preview)}</pre>
      ))}
      <button disabled={!open} onClick={() => respond(Decision.answerAll(props, "approved"))}>
        Approve
      </button>
      <button disabled={!open} onClick={() => respond(Decision.answerAll(props, "declined"))}>
        Decline
      </button>
    </div>
  )
})

// In a message: renderBlock(message, { respond: (answer) => submit(chatId, answer) })
```

`BlockKit.closeStale({ messages: 3 })` in a handler closes blocks the user
has moved on from. See [blocks](./apps/docs/guide/blocks.md).

### Specialists: background work

A specialist is a focused agent the assistant hands a brief to. It runs in
the background, and its report comes back as an event the assistant reads
and decides whether to pass on. The assistant can message or stop a run
while it works.

```ts
import { Specialist } from "effect-assistant"

const Research = Specialist.make("research", {
  description: "Digs through past orders and campaigns. Slow: runs in the background."
})

const ResearchLive = Research.toLayer((run) =>
  run.loop({ instructions: "Answer in a few lines.", toolkit: researchTools, maxSteps: 24 })
)

export const MyAssistant = Assistant.make("my-assistant", { specialists: [Research] })

const MyAssistantHandlers = MyAssistant.toLayer((turn) => turn.loop({ instructions, toolkit })).pipe(
  Layer.provide(ResearchLive)
)
```

To give a specialist its own model, provide a different `LanguageModel` to
its layer. See [specialists](./apps/docs/guide/specialists.md).

### Skills and large tool catalogs

A skill is a playbook. Only its name and a single line appear in the
prompt, and the model loads the rest with `load_skill` when a task matches.
`ToolDiscovery.make` turns a large toolkit into `search_tools` and
`execute_tool`, so the prompt doesn't carry every tool definition.

```ts
import { Skill, ToolDiscovery } from "effect-assistant"

const reorder = Skill.make({
  name: "reorder",
  description: "Reordering something the user ordered before.",
  instructions: "1. Find their last order of it. 2. Confirm quantity and address. 3. Place it."
})

MyAssistant.toLayer((turn) =>
  turn.loop({
    instructions,
    toolkit: AssistantLoop.merge(coreTools, ToolDiscovery.make(catalog)),
    skills: [reorder]
  })
)
```

A skill's `instructions` can be an Effect, resolved each time it loads, for
example from a prompt store. `AssistantLoop.only(tools, predicate)` hides
tools a user may not use. See [skills](./apps/docs/guide/skills.md) and
[tools](./apps/docs/guide/tools.md).

### Your own events: webhooks, workflows, drafts

Register your own tagged schemas with the assistant. An event with
`wakes: true` starts a turn, like a user message, and the model reads it as
`render` describes. The user sees it only if the assistant tells them.
Events that don't wake a turn are bookkeeping that a handler reads back
with `turn.entries`.

```ts
import { AppEvent, InputId } from "effect-assistant"

class ShipmentUpdated extends Schema.TaggedClass<ShipmentUpdated>()("ShipmentUpdated", {
  id: InputId.InputId,
  orderId: Schema.String,
  status: Schema.String
}) {}

export const MyAssistant = Assistant.make("my-assistant", {
  events: [
    AppEvent.make(ShipmentUpdated, {
      wakes: true,
      render: (update) => `<update>Order ${update.orderId} is ${update.status}. The user hasn't seen this.</update>`
    })
  ]
})

// From a webhook. The keyed id makes a redelivered webhook harmless.
MyAssistant.submit(
  chatId,
  ShipmentUpdated.make({ id: InputId.fromKey(`shipment:${orderId}:${status}`), orderId, status })
)
```

See [your own events](./apps/docs/guide/app-events.md).

### Per-user turns, memory, and long chats

A handler can be an Effect. It runs once per chat activation, with the
services your layer provides, and returns the function that runs each turn.
This is where you look up whom the chat is for, give tools that user, and
build prompts. The example below also adds two optional pieces:

- **Memory** (`Memory`) keeps facts across chats: a personal scope and a
  team scope, with `remember`, `forget`, and `recall` tools. Use
  `Memory.layerSql` with a `memory_facts` table in production.
- **Compaction** (`Compaction`) lets a long chat read a summary in place
  of everything before it. You decide when to summarize and which model
  writes the summary. The library supplies the pieces.

```ts
import { AppEvent, Compaction, Memory } from "effect-assistant"
import * as LanguageModel from "effect/ai/LanguageModel"

class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  text: Schema.String,
  throughSeq: Schema.Int
}) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [AppEvent.make(Summary)] })

const sinceSummary = Compaction.since(Schema.is(Summary))

const MyAssistantHandlers = MyAssistant.toLayer(
  Effect.gen(function* () {
    // Once per chat activation.
    const owners = yield* ChatOwners // your service: whom a chat is for
    const store = yield* Memory.MemoryStore

    // Every turn.
    return (turn) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const user = yield* owners.forChat(turn.chatId)
          const scopes = { personal: `user:${user.id}`, shared: `team:${user.teamId}` }
          const facts = yield* Memory.facts(scopes).pipe(Effect.provideService(Memory.MemoryStore, store))
          const remembered = Option.getOrElse(Memory.render(facts, scopes), () => "")

          const compact = Effect.gen(function* () {
            const entries = yield* turn.entries

            if (Compaction.inputTokens(entries) < 100_000) return

            const response = yield* LanguageModel.generateText({
              prompt: `Summarize this chat for whoever picks it up:\n\n${transcript(entries)}`
            })

            yield* turn.append(Summary.make({ text: response.text, throughSeq: entries.at(-1)?.seq ?? 0 }))
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("compaction failed", cause)))

          return Stream.concat(
            turn.loop({
              instructions: `You help ${user.name}. Be brief.\n\n${remembered}`,
              toolkit: AssistantLoop.merge(toolkit, Memory.makeToolkit(scopes)),
              history: sinceSummary
            }),
            // After the reply, so the user doesn't wait for it.
            Stream.drain(Stream.fromEffect(compact))
          ).pipe(
            Stream.provideService(CurrentUser, user), // for tools that declare it as a dependency
            Stream.provideService(Memory.MemoryStore, store)
          )
        })
      )
  })
)
```

A prompt that changes between turns breaks the provider's prompt cache.
Facts that another chat writes would change this chat's system prompt. To
keep the prefix stable, store what the chat remembered as one of your own
events when the chat starts, and put it in the history with a `history`
view. See [assistants and handlers](./apps/docs/guide/assistant.md) and
[instructions](./apps/docs/guide/instructions.md).

### Testing and tracing

- **Tests.** The engine only needs a `LanguageModel` layer. This
  package's own tests run on a scripted model
  (`packages/effect-assistant/test/utils/scripted.ts`) that answers each
  request with the tool calls you script, so no API key is needed. See
  [testing](./apps/docs/guide/testing.md).
- **Tracing.** Turns, model calls, and tool calls are OpenTelemetry GenAI
  spans. Provide a tracer, for example Langfuse over OTLP, and they show up
  with token usage. `TurnStarted` stores the turn's trace id. See
  [observability](./apps/docs/guide/observability.md).

## This repository

| Path                        | What                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/effect-assistant` | The library.                                                                                          |
| `packages/demo/api`         | A demo server for a fictional company, Acme: tools, prompts, a durable workflow with a decision, RPC. |
| `packages/demo/shared`      | What the demo's web app and API share: RPCs, UI blocks, ids, demo data.                               |
| `apps/web`                  | The demo's chat UI. One RPC WebSocket per tab.                                                        |
| `apps/docs`                 | The docs site: guides, and an API reference generated from the library's JSDoc.                       |

```bash
pnpm install
pnpm dev            # demo API on :8787 (in memory, or Postgres with DATABASE_URL), web on :3000
pnpm docs:dev       # docs on :5173
pnpm check          # format, lint, and type check
pnpm test           # on a scripted model, no API key needed
pnpm test:contract  # the library against a real model (ANTHROPIC_API_KEY in .env.local)
pnpm build
```

The demo runs as one Node 24 service: `pnpm build`, then `pnpm start:node`.
With `DATABASE_URL`, the chat log, thread list, cluster entities, and
workflows share one Postgres pool. With `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY`, traces and prompts go through Langfuse.
