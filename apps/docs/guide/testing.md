# Testing

Test an assistant the way it runs: the memory engine and log, and
assertions about what the user was shown. Test two things separately.

## The mechanics, on a scripted model

What your tools and handlers do with what the model answers doesn't depend
on the model: a tool's side effects, a workflow's events, a custom loop.
Script the model's answers and assert on the log: `LanguageModel.make` from
`effect/ai` takes a `generateText` that returns the response parts
you want (tool calls, text), and sees each request's prompt and tools. These
tests are fast, free, and deterministic, so they run on every change.

**Example** (A model that always replies)

```ts
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/ai/LanguageModel"

const Replies = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () =>
      Effect.succeed([
        { type: "tool-call", id: "call_1", name: "send_user_message", params: { text: "Hi.", wait: true } },
        { type: "finish", reason: "tool-calls", usage: { inputTokens: {}, outputTokens: {} } }
      ]),
    streamText: () => Stream.die("not streamed")
  })
)
```

effect-assistant's own tests do this for its mechanics: messages that
arrive mid-turn, specialist runs, blocks, crash recovery, both engines.

## The behaviour, on the real model

Whether the assistant tells the user, picks the right tool, or uses a block
depends on your prompts, your tools, and the model: test it with the real
model, a small, fast one like `claude-haiku-4-5`, as evals of your app. Keep
assertions about outcomes ("the answer mentions Ottawa", "it called
`spawn_specialist`"), not exact wording, and run them on main or nightly
rather than on every change.

## Use the memory layers

Everything runs in one process with `AssistantEngine.layerMemory` and the
memory event log. That's all an engine needs. A chat is just a new id,
`ChatId.make()`:

```ts
import { describe, expect, it } from "@effect/vitest"

const AssistantTest = MyAssistant.toLayer((turn) => turn.loop({ instructions, toolkit })).pipe(
  Layer.provide(AnthropicLanguageModel.model("claude-haiku-4-5")),
  Layer.provide(AnthropicClientLive),
  Layer.provideMerge(AssistantEngine.layerMemory),
  Layer.provideMerge(ChatLog.layerMemory)
)

it.live("uses a tool and reports its result", () =>
  Effect.gen(function* () {
    const assistant = yield* MyAssistant
    const chatId = yield* ChatId.make()
    yield* assistant.submit(chatId, AssistantEvent.UserMessage.make({ text: "What's the weather in Oslo?" }))

    const entries = yield* assistant.subscribe(chatId).pipe(
      Stream.takeUntil(({ event }) => Predicate.isTagged(event, "TurnCompleted")),
      Stream.runCollect
    )

    expect(AssistantEvent.assistantTexts(entries).join(" ")).toContain("Oslo")
  }).pipe(Effect.provide(AssistantTest))
)
```

The cluster engine works in tests too, on Effect's in-process cluster: use
`AssistantEngine.layerCluster` and provide `TestRunner.layer` in place of a
real runner. Use `it.live`, not `it.effect`, with either: turns run on real
timers, and `it.effect`'s test clock never moves on its own.

To test what a handler does for different users, give it a `ChatUsers`
layer over a test map from chat id to user, and make a chat for each user.
The handler looks the user up from `turn.chatId`, as in the app.

## Test what talks to the assistant

Code that only notifies the assistant, like a workflow, doesn't need the model
to answer. Run the assistant with a handler that doesn't call it, and read
what arrived from the chat's log. Give each specialist an empty handler too
(`Research.toLayer(() => Stream.empty)`):

```ts
const QuietAssistant = MyAssistant.toLayer(() => Stream.empty).pipe(
  Layer.provide(Replies), // the layer wants a model; nothing calls it
  Layer.provideMerge(AssistantEngine.layerMemory),
  Layer.provideMerge(ChatLog.layerMemory)
)

// The log is the storage underneath; a test can read it directly.
const inputsOf = (chatId: ChatId.ChatId) =>
  ChatLog.ChatLog.use((log) => log.read(chatId)).pipe(
    Effect.map((entries) => entries.flatMap(({ event }) => (AssistantEvent.isInput(event) ? [event] : [])))
  )
```

## Test the pure parts directly

The history rules, block states, the chat's view, and client renderers are
plain functions: test them without a model. `BlockKit.fromEntries` and
`ChatView.fromEntries` take entries you build with the `AssistantEvent`
constructors, and `BlockKit.toClient` renders the messages of the view.
