<p align="left">
  <a href="https://www.npmjs.com/package/effect-assistant"><img alt="npm version" src="https://img.shields.io/npm/v/effect-assistant.svg"></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/effect-assistant.svg"></a>
  <a href="https://effect.website"><img alt="Built on Effect" src="https://img.shields.io/badge/built%20on-Effect%204-black"></a>
</p>

> [!WARNING]
> effect-assistant is under active development. APIs may change between minor versions until 1.0.

# effect-assistant

effect-assistant is a TypeScript library for chat assistants that work like a colleague: you message it, it works
in the background with your tools, and it messages you back. It is built on [Effect](https://effect.website) and
`effect/ai`.

Each chat is one append-only log of events. What the model reads, what the user sees, and where a turn cut off by a
crash picks up are all read from that log.

## Quickstart

```sh
pnpm add effect-assistant effect@^4.0.0 @effect/ai-anthropic@^4.0.0
```

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
  turn.run({ instructions: "You help a small team. Be brief.", toolkit: WeatherTools })
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

### A turn is a stream

`submit` appends the input to the chat's log and returns; a turn starts in the background. The handler returns
the turn as a `Stream` of what the agent loop does, and the engine writes each event to the log before it pulls the
next, so a turn cut off by a crash picks up where it stopped. Change a turn with ordinary stream code:

```ts
const MyAssistantLive = MyAssistant.toLayer((turn) =>
  turn.run({ instructions, toolkit: WeatherTools }).pipe(
    Stream.concat(Stream.drain(Stream.fromEffect(afterTheReply))) // the user doesn't wait for it
  )
)
```

```text
submit ──► chat log ──► history ──► turn.run ──► events ──┐
              ▲                                           │
              └───────────────────────────────────────────┘
chat log ──► Timeline.changes ──► client
```

### Every model call reads the log

The model's history is rebuilt from the log before each call. A message the user sends while a turn runs is read
at the turn's next step, so follow-ups join the work instead of queueing behind it.

### The model speaks through a tool

The model's own text never reaches the user. It sends a message with `send_user_message`, sets `wait` on its last
one, and ends a turn with nothing to say with the `wait` tool. Tool output and working notes stay out of the chat.
A turn that stops after "On it" without the result gets one more pass to deliver it.

### The user sees a timeline

The client never reads the log. `Timeline.changes` turns it into the chat as the user sees it (messages, blocks,
approvals, whether something is working), and the client folds the changes:

```ts
const watch = (chatId: ChatId.ChatId) =>
  Stream.unwrap(MyAssistant.useSync((assistant) => assistant.subscribe(chatId).pipe(Timeline.changes(MyAssistant))))

// In the client: a stream of timelines, or Timeline.apply(timeline, change) one change at a time
const timelines = changes.pipe(Timeline.fold)
```

Your own events reach the client only when the server names them: `Timeline.changes(MyAssistant, { show: [OrderPlaced] })`.

### Blocks: answers and results

A block is UI under a message. One with an `answer` schema asks the user something; their click comes back as an
input. One made from a tool shows that tool's result, so the model never copies ids or signed links into props:

```ts
const PickOne = Block.make("pick_one", {
  description: "Options to pick from, when the user chooses between a few.",
  props: Schema.Struct({ options: Schema.Array(Schema.String) }),
  answer: Schema.Struct({ picked: Schema.String })
})

const Blocks = BlockKit.make([PickOne, Block.fromToolResult(SearchItems)])
export const MyAssistant = Assistant.make("my-assistant", { blocks: Blocks })

// In the client: a renderer per kind, checked by the type system.
const render = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
  pick_one: ({ props, open, respond }) => <Options options={props.options} disabled={!open} onPick={(picked) => respond({ picked })} />,
  search_items: ({ result }) => <ItemCards items={result.items} />
})
```

### Ask before acting

A tool made with Effect's `needsApproval` doesn't run when the model calls it. The turn ends, the timeline shows the
call with the assistant's message beside it, and the user's decision is an input; an approved call runs then, once.

```ts
const PlaceOrder = Tool.make("place_order", {
  description: "Places an order. The user approves it first; say what you're asking them to approve.",
  parameters: Schema.Struct({ sku: Schema.String, quantity: Schema.Int }),
  success: Schema.Struct({ orderId: Schema.String }),
  needsApproval: true,
  dependencies: [AssistantToolCall.AssistantToolCall] // its idempotency key, so a re-run places it once
})

// In the client
submit(ToolApproval.approve(item)) // or ToolApproval.reject(item, { reason })
```

### History is a view

What the model reads is a function of the log. Long chats store a summary as one of your events, and the model
reads the last summary plus what came after; the log keeps everything, so the user still sees the whole chat.

```ts
turn.run({ instructions, history: Compaction.since(Schema.is(Summary)) })
```

### Putting it together

One assistant with all of it: tools with an approval, a skill, memory, blocks that show a tool's result, a specialist,
and a summary after the reply once the chat is long. `PlaceOrder` and `PickOne` are as
above, `SearchProducts` is a tool like `get_weather`, `Reorder` a [skill](./apps/docs/guide/skills.md) and `Research` a
[specialist](./apps/docs/guide/specialists.md).

```ts
class Summary extends Schema.TaggedClass<Summary>()("Summary", { text: Schema.String, throughSequence: Schema.Int }) {}

const ShopTools = Toolkit.make(SearchProducts, PlaceOrder) // PlaceOrder has needsApproval
const Skills = Skill.toolkit([Reorder])

export const Shop = Assistant.make("shop", {
  blocks: BlockKit.make([PickOne, Block.fromToolResult(SearchProducts)]),
  events: [Summary],
  specialists: [Research]
})

// Runs after the reply, so the user doesn't wait; only once the chat is long.
const compact = Effect.gen(function* () {
  const chat = yield* Shop.Chat
  const entries = yield* chat.entries

  if (Compaction.inputTokens(entries) < 100_000) return

  const { text } = yield* LanguageModel.generateText({ prompt: `Summarize:\n\n${transcript(entries)}` })

  yield* chat.append(Summary.make({ text, throughSequence: entries.at(-1)?.sequence ?? 0 }))
}).pipe(Effect.orDie)

export const ShopLive = Shop.toLayer(
  Effect.gen(function* () {
    const memory = yield* Memory.MemoryStore

    return (turn) =>
      Stream.unwrap(
        Effect.map(memory.facts(turn.chatId), (facts) =>
          turn.run({
            instructions: `${instructions}\n\n${Memory.render(facts)}`,
            toolkit: Toolkit.merge(ShopTools, Memory.Tools, Skills),
            history: Compaction.since(Schema.is(Summary)),
            maxSteps: 20
          })
        )
      ).pipe(Stream.concat(Stream.drain(Stream.fromEffect(compact))), Stream.provideService(Memory.MemoryStore, memory))
  })
).pipe(Layer.provide([ShopToolsLive, Memory.layerTools, Skills.layer, ResearchLive]), Layer.provide(MemoryStoreLive))
```

```text
chat log ─► Compaction.since(Summary) ─► history ──┐
memory facts ─► instructions ──────────────────────┼─► turn.run ─► events ─► chat log
ShopTools + Memory.Tools + Skills ─► toolkit ──────┘
compact, after the reply ─► Summary ─► chat log
```

### And more

- [Specialists](./apps/docs/guide/specialists.md): focused agents that do slow work in the background.
- [Skills and tool discovery](./apps/docs/guide/skills.md): playbooks loaded on demand, and big toolkits behind `search_tools`.
- [Memory](./apps/docs/guide/memory.md): facts kept between chats, in a store you implement.
- [Your own events](./apps/docs/guide/app-events.md): webhooks and workflows that report into a chat.
- [Chats](./apps/docs/guide/chats.md): which chats exist, who may use them, and deleting them.
- [Testing](./apps/docs/guide/testing.md): a scripted model, so tests need no API key.

## Hosting

In production each chat runs as an Effect Cluster entity, so one process writes each chat and a crashed turn
resumes, and the log goes to SQL:

```ts
const AppLive = MyAssistantLive.pipe(
  Layer.provide(ModelLive),
  Layer.provideMerge(AssistantEngine.layerCluster),
  Layer.provideMerge(
    Layer.merge(ChatLog.layerSql(), SingleRunner.layer({ runnerStorage: "sql" }).pipe(Layer.provide(NodeCrypto.layer)))
  ),
  Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }))
)
```

```sql
CREATE TABLE chat_log (
  chat_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  at DOUBLE PRECISION NOT NULL,
  event TEXT NOT NULL, -- LONGTEXT in MySQL
  PRIMARY KEY (chat_id, sequence)
);
```

- `ChatLog.layerSql({ table: "my_chat_log" })` uses a table of your naming.
- `ChatLog.make(storage)` stores the log anywhere else (an ORM, another client), with `ChatLog.EventJson` for the
  same JSON.
- A process that only serves clients provides `MyAssistant.layerClient` with `AssistantEngine.layerClusterClient`:
  no handler, no log, and its calls reach the runners.

See [deploying](./apps/docs/guide/deploying.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

| Path                        | What                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `packages/effect-assistant` | The library.                                                                            |
| `packages/demo/api`         | A demo server for a fictional company, Acme: tools, orders from blocks, workflows, RPC. |
| `packages/demo/shared`      | What the demo's web app and API share: RPCs, UI blocks, ids, demo data.                 |
| `apps/web`                  | The demo's chat UI.                                                                     |
| `apps/docs`                 | The docs site, with the guides and the API reference generated from the JSDoc.          |

```sh
pnpm install
pnpm dev            # demo API on :8787 (in memory, or Postgres with DATABASE_URL), web on :3000
pnpm docs:dev       # docs on :5173
pnpm check          # format, lint, and type check
pnpm test           # on a scripted model, no API key needed
pnpm test:contract  # against a real model (ANTHROPIC_API_KEY in .env.local)
```
