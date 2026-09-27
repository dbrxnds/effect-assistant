# Testing

Test an assistant the way it runs: the memory engine and log, a real model,
and assertions about what the user was shown.

## Use the real model

effect-assistant's own tests call the real model: a small, fast one
(`claude-haiku-4-5`). Most of what matters in an assistant is behaviour, like
whether it tells the user, picks the right tool, or uses a block, and a mock
model can't tell you that. Keep assertions about outcomes ("the answer
mentions Ottawa", "it called `spawn_specialist`"), not exact wording.

## Use the memory layers

Everything runs in one process with `AssistantEngine.layerMemory` and the
memory event log. That's all an engine needs. A chat is just a new id,
`ChatId.make`:

```ts
import { describe, expect, it } from "@effect/vitest"

const AssistantTest = MyAssistant.toLayer((turn) =>
  turn.loop({ model: "claude-haiku-4-5", instructions, toolkit })
).pipe(
  Layer.provide(AnthropicLive),
  Layer.provideMerge(AssistantEngine.layerMemory),
  Layer.provideMerge(ChatLog.layerMemory)
)

it.live("uses a tool and reports its result", () =>
  Effect.gen(function* () {
    const chatId = yield* ChatId.make
    yield* MyAssistant.submit(
      chatId,
      AssistantEvent.UserMessage.make({ id: yield* InputId.make, text: "What's the weather in Oslo?" })
    )

    const entries = yield* MyAssistant.subscribe(chatId).pipe(
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
  Layer.provide(AnthropicLive), // the layer wants a model API; nothing calls it
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

The history rules, block states, and client renderers are plain functions:
test them without a model. `BlockKit.blockStates` and `BlockKit.toClient` take
entries and messages you build with the `AssistantEvent` constructors.
