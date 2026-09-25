# Getting started

This page builds an assistant, sends it a message, and prints its reply.
Everything runs in one process; all you need is an Anthropic API key.

## Install

`effect` and `@effect-uai/core` are peer dependencies: your app brings its own,
so there's one copy of each. Add a model provider too, here `@effect-uai/anthropic`.

```bash
pnpm add effect-assistant effect@4.0.0-rc.117 @effect-uai/core@0.17.0 @effect-uai/anthropic@0.17.0
```

## Define an assistant

**Example** (A first assistant)

```ts
import * as Anthropic from "@effect-uai/anthropic/Anthropic"
import { Assistant, AssistantEngine, ChatLog } from "effect-assistant"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

// The definition: submit and subscribe are on it.
export const MyAssistant = Assistant.make("my-assistant")

// The handler: every turn runs the agent loop with these instructions.
const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({ model: "claude-sonnet-5", instructions: "You help a small marketing team. Be brief." })
)

// The model API: effect-uai's Anthropic layer provides `LanguageModel`.
const AnthropicLive = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("ANTHROPIC_API_KEY")
    return Anthropic.layer({ apiKey }).pipe(Layer.provide(FetchHttpClient.layer))
  })
)

// The handler on an engine, with an event log and the model API. All in memory.
export const MyAssistantLive = MyAssistantHandlers.pipe(
  Layer.provide(AnthropicLive),
  Layer.provideMerge(AssistantEngine.layerMemory),
  Layer.provideMerge(ChatLog.layerMemory)
)
```

That's the three parts of every assistant, the same split as an Effect
workflow:

- the **definition**, `Assistant.make`, which your server and UI import;
- the **handler**, `toLayer`, which runs each turn;
- the **engine**, here `AssistantEngine.layerMemory`, which runs the chats.
  It stores them in an event log, here `ChatLog.layerMemory`.

[Assistants and handlers](./assistant) covers each one.

## Send it a message

A chat is a `ChatId`. `submit` stores a message in it and returns at once;
the assistant works in the background. `subscribe` streams the chat's events,
stored ones first, then live ones.

**Example** (Submit, then read the reply)

```ts
import { AssistantEvent, ChatId, InputId } from "effect-assistant"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"

const program = Effect.gen(function* () {
  const chatId = yield* ChatId.make

  yield* MyAssistant.submit(
    chatId,
    AssistantEvent.UserMessage.make({ id: yield* InputId.make, text: "Hi! What can you do?" })
  )

  yield* MyAssistant.subscribe(chatId).pipe(
    Stream.takeUntil(({ event }) => Predicate.isTagged(event, "TurnCompleted")),
    Stream.runForEach(({ event }) =>
      Predicate.isTagged(event, "AssistantMessage") ? Console.log(`assistant: ${event.text}`) : Effect.void
    )
  )
})

Effect.runPromise(program.pipe(Effect.provide(MyAssistantLive)))
// assistant: Hi! I can help with campaigns, copy, and planning. What are you working on?
```

A chat UI does the same: it renders the `UserMessage` and `AssistantMessage`
events, and shows a working indicator while
[`AssistantActivity`](./events#what-is-working) says something is working.

::: tip The assistant talks only through a tool
The model's plain text never reaches the user. It sends a message by calling
`send_user_message`, so it decides what the user hears. See [turns](./turns).
:::

## Give it a tool

Tools are [effect-uai](https://github.com/betalyra/effect-uai) tools: a name,
a description, an input schema, and an Effect to run. Pass them to
`turn.loop` as a `toolkit`.

**Example** (A weather tool)

```ts
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const WeatherInput = Schema.Struct({ city: Schema.String })

const weather = Tool.make({
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: WeatherInput,
  run: Effect.fn(function* ({ city }: typeof WeatherInput.Type) {
    return { city, weather: "sunny, 21°C" }
  })
})

const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({
    model: "claude-sonnet-5",
    instructions: "You help a small marketing team. Be brief.",
    toolkit: Toolkit.make(weather)
  })
)
```

Ask it "What's the weather in Oslo?" and it calls `get_weather`, then tells
you. [Tools](./tools) has the rest: failures, the chat a tool runs in, and
large catalogs.

## Next steps

- [Assistants and handlers](./assistant): what a handler can do, and what it may use.
- [Turns](./turns): how the assistant works through a chat, and how you interrupt it.
- [Chats and users](./chats): whom a chat is for, and checking access.
- [Deploying](./deploying): the SQL log and the cluster engine.
