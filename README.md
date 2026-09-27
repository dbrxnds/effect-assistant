# effect-assistant

A colleague-style chat assistant library on [Effect](https://effect.website),
with a demo app built on it. You chat with the assistant like with a coworker.
It looks things up, starts durable workflows (you approve in the chat), runs
research in the background, and messages you when there's news.

| Path                        | What                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/effect-assistant` | The assistant library: event log, agent loop, specialists, skills, UI blocks, memory and cluster layers. [Docs](./apps/docs)                    |
| `packages/demo/api`         | The demo server, for a fictional company, Acme: assistant config, tools and prompts, the `CreateCampaign` workflow, RPC, and the built web app. |
| `packages/demo/shared`      | What web and API share: RPCs, UI blocks, ids, and demo data (orders, offices).                                                                  |
| `apps/web`                  | Chat UI. One RPC WebSocket per tab.                                                                                                             |
| `apps/docs`                 | Docs site for effect-assistant.                                                                                                                 |

## Setup

An assistant with one tool, in memory, that answers a message. All it needs is
`ANTHROPIC_API_KEY`. The [getting started guide](./apps/docs/guide/getting-started.md)
walks through it.

```ts
import * as Anthropic from "@effect-uai/anthropic/Anthropic"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { Assistant, AssistantEngine, AssistantEvent, ChatId, ChatLog, InputId } from "effect-assistant"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

// The definition: your server and UI import it for submit and subscribe.
const MyAssistant = Assistant.make("my-assistant")

const WeatherInput = Schema.Struct({ city: Schema.String })

const weather = Tool.make({
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: WeatherInput,
  run: Effect.fn(function* ({ city }: typeof WeatherInput.Type) {
    return { city, weather: "sunny, 21°C" }
  })
})

// The handler: every turn runs the agent loop.
const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({
    model: "claude-sonnet-5",
    instructions: "You help a small team. Be brief.",
    toolkit: Toolkit.make(weather)
  })
)

const AnthropicLive = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("ANTHROPIC_API_KEY")
    return Anthropic.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))
  })
)

// The engine runs the chats and stores them in a log; both in memory here.
const MyAssistantLive = MyAssistantHandlers.pipe(
  Layer.provide(AnthropicLive),
  Layer.provideMerge(AssistantEngine.layerMemory),
  Layer.provideMerge(ChatLog.layerMemory)
)

const program = Effect.gen(function* () {
  const chatId = yield* ChatId.make

  // Returns at once: the assistant works in the background.
  yield* MyAssistant.submit(
    chatId,
    AssistantEvent.UserMessage.make({ id: yield* InputId.make, text: "What's the weather in Oslo?" })
  )

  // The chat's events, stored ones first, then live ones.
  yield* MyAssistant.subscribe(chatId).pipe(
    Stream.takeUntil(({ event }) => Predicate.isTagged(event, "TurnCompleted")),
    Stream.runForEach(({ event }) =>
      Predicate.isTagged(event, "AssistantMessage") ? Console.log(`assistant: ${event.text}`) : Effect.void
    )
  )
})

Effect.runPromise(program.pipe(Effect.provide(MyAssistantLive)))
// assistant: Oslo: sunny, 21°C
```

For production, swap in `ChatLog.layerSql` and `AssistantEngine.layerCluster`:
see [deploying](./apps/docs/guide/deploying.md).

## Run

```bash
pnpm install
pnpm dev            # API on :8787 (in memory, or Postgres with DATABASE_URL), web on :3000
pnpm docs:dev       # effect-assistant docs on :5173
pnpm check          # vp check: format, lint, and type check
pnpm test           # effect-assistant tests call the real model (ANTHROPIC_API_KEY in .env.local)
```

## Deploy

The demo runs as one Node 24 web service. Build: `pnpm install --frozen-lockfile; pnpm run build`.
Start: `pnpm start:node`. With `DATABASE_URL`, the assistant log, thread list, cluster
entities, and workflows share one Postgres pool. With `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY`, traces and prompts come from Langfuse.

Smoke test a deployment (real model, real RPC socket):

```bash
pnpm --filter @acme/demo-api smoke https://your-demo.example.com
```
