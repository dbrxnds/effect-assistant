# Getting started

This page builds an assistant, sends it a message, and prints its reply.
Everything runs in one process; all you need is an Anthropic API key.

## Install

`effect` is a peer dependency: your app brings its own, so there's one copy.
The library runs on Effect's AI modules (`effect/ai`); add a model
provider for them, here `@effect/ai-anthropic`.

```bash
pnpm add effect-assistant effect@4.0.0 @effect/ai-anthropic@4.0.0
```

## Define an assistant

**Example** (A first assistant)

```ts
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"
import { Assistant, AssistantEngine, ChatLog } from "effect-assistant"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"

// The definition: submit and subscribeView are on it.
export const MyAssistant = Assistant.make("my-assistant")

// The handler: every turn runs the agent loop with these instructions.
const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({ instructions: "You help a small marketing team. Be brief." })
)

// The model: a `LanguageModel`, here Anthropic's. The loop calls whichever one the layer is given.
const ModelLive = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("ANTHROPIC_API_KEY")

    return AnthropicLanguageModel.model("claude-sonnet-5").pipe(
      Layer.provide(AnthropicClient.layer({ apiKey })),
      Layer.provide(FetchHttpClient.layer)
    )
  })
)

// The handler on an engine, with an event log and the model. All in memory.
export const MyAssistantLive = MyAssistantHandlers.pipe(
  Layer.provide(ModelLive),
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
the assistant works in the background. `subscribeView` streams the chat as
its user sees it: the messages, and whether the assistant is working.

**Example** (Submit, then read the reply)

```ts
import { AssistantEvent, ChatId, ChatView, InputId } from "effect-assistant"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const program = Effect.gen(function* () {
  const chatId = yield* ChatId.make

  yield* MyAssistant.submit(
    chatId,
    AssistantEvent.UserMessage.make({ id: yield* InputId.make, text: "Hi! What can you do?" })
  )

  const view = yield* MyAssistant.subscribeView(chatId).pipe(
    Stream.scan(() => ChatView.empty, ChatView.apply),
    Stream.takeUntil((view) => view.messages.length > 1 && ChatView.isIdle(view)),
    Stream.runLast
  )

  yield* Console.log(view)
})

Effect.runPromise(program.pipe(Effect.provide(MyAssistantLive)))
// { messages: [{ _tag: "UserMessage", text: "Hi! What can you do?" }, { _tag: "AssistantMessage", text: "Hi! I can help with …" }], … }
```

A chat UI does the same over RPC: it folds the updates and renders the
messages, and shows a working indicator while the view's `activity` says
something works. See [the chat client](./client).

`subscribe` streams the chat's whole log instead, every event the
assistant stored, for server-side code and tests:

**Example** (The log, for the server)

```ts
const printLog = (chatId: ChatId.ChatId) =>
  MyAssistant.subscribe(chatId).pipe(
    Stream.takeUntil(({ event }) => Predicate.isTagged(event, "TurnCompleted")),
    Stream.runForEach(({ seq, event }) => Console.log(seq, event._tag))
  )
// 1 UserMessage
// 2 TurnStarted
// 3 ModelOutput
// …
```

::: tip The assistant talks only through a tool
The model's plain text never reaches the user, and neither do its tool calls
or their results: they're its own work. It sends a message by calling
`send_user_message`, so it decides what the user hears. See [turns](./turns).
:::

## Give it a tool

Tools are Effect's own (`effect/ai/Tool`): a name, a description,
schemas for the parameters and the result, and a handler. `AssistantLoop.fromToolkit`
turns a toolkit and its handlers into tools for `turn.loop`.

**Example** (A weather tool)

```ts
import { AssistantLoop } from "effect-assistant"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"

const GetWeather = Tool.make("get_weather", {
  description: "Current weather for a city.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ city: Schema.String, weather: Schema.String })
})

const toolkit = AssistantLoop.fromToolkit(Toolkit.make(GetWeather), {
  get_weather: ({ city }) => Effect.succeed({ city, weather: "sunny, 21°C" })
})

const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({ instructions: "You help a small marketing team. Be brief.", toolkit })
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
