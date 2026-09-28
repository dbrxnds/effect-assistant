# effect-assistant

A colleague assistant on Effect. You send it messages; it works in the background,
uses tools, starts long-running work, and messages you when it has something
to say. Messages you send while it works are picked up at its next step. Its
model calls, tool calls, and their results are its own work: the user sees
only what it sends with `send_user_message`.

It runs on Effect's AI modules (`effect/unstable/ai`): any `LanguageModel`
provider, like `@effect/ai-anthropic`, and native `Tool`s and toolkits.

```ts
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"
import {
  Assistant,
  AssistantEngine,
  AssistantLoop,
  type AssistantEvent,
  type ChatId,
  ChatLog,
  Specialist
} from "effect-assistant"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

// Definitions: what callers and the UI need to know.
const Research = Specialist.make("research", { description: "Researches past campaigns." })

export const MyAssistant = Assistant.make("my-assistant", { blocks: Blocks, specialists: [Research] })

// Handlers: the build Effect runs once per chat activation; the function runs every turn (or brief).
const MyAssistantLive = MyAssistant.toLayer(
  Effect.gen(function* () {
    const prompts = yield* Prompts // from the layer
    const users = yield* ChatUsers // the app's chat table: whose chat is it
    const toolkit = AssistantLoop.tools(yield* OrderTools) // a native toolkit, with its handlers' layer

    return (turn) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const user = yield* users.forChat(turn.chatId)

          return turn
            .loop({ instructions: yield* prompts.get(user), toolkit, skills: [orderingCampaigns] })
            .pipe(Stream.provideService(CurrentUser, user)) // for tools that declare it as a dependency
        })
      )
  })
).pipe(Layer.provide(OrderToolsLive))

const ResearchLive = Research.toLayer(
  Effect.gen(function* () {
    const users = yield* ChatUsers
    const toolkit = AssistantLoop.tools(yield* ResearchTools)

    return (run) =>
      Stream.unwrap(
        Effect.map(users.forChat(run.chatId), (user) =>
          run.loop({ instructions: "Answer in a few lines.", toolkit }).pipe(Stream.provideService(CurrentUser, user))
        )
      )
  })
).pipe(Layer.provide([ResearchToolsLive, AnthropicLanguageModel.model("claude-haiku-4-5")])) // its own model

// One engine for the app: each chat is a cluster entity. Or in the process: AssistantEngine.layerMemory.
export const AppLive = MyAssistantLive.pipe(
  Layer.provide([ResearchLive, PromptsLive, ChatUsersLive]),
  Layer.provide(AnthropicLanguageModel.model("claude-sonnet-5", { cache_control: { type: "ephemeral" } })),
  Layer.provide(AnthropicClientLive),
  Layer.provideMerge(AssistantEngine.layerCluster),
  Layer.provideMerge(Layer.merge(ChatLog.layerSql, SingleRunnerLive))
)

// Whom a chat is for is the app's data. At the edge, check the signed-in user may use it:
const send = (userId: string, chatId: ChatId.ChatId, message: AssistantEvent.UserInput) =>
  checkAccess(userId, chatId).pipe(Effect.andThen(MyAssistant.submit(chatId, message)))

// What the user's client gets: the chat as they see it, never the assistant's own work.
const view = (userId: string, chatId: ChatId.ChatId) =>
  Stream.unwrap(checkAccess(userId, chatId).pipe(Effect.as(MyAssistant.subscribeView(chatId))))
```

What the assistant can't do on its own waits for the user's decision: a tool
with Effect's `needsApproval` is parked when the model calls it, with a
preview of what it will do, and a workflow asks with `Decision.durable`. The
model asks the user with the decision block (`Decision.block`), and only the
user's answer to it runs the call or resumes the workflow. See the
[decisions guide](../../apps/docs/guide/decisions.md).

What background work reports is the app's own event: registered with
`AppEvent.make(schema, { wakes: true, render })`, it wakes a turn and reads
in the model's history as its `render` says, and the user sees it only if
the assistant tells them. Events that don't wake a turn are the app's
bookkeeping. See [your own events](../../apps/docs/guide/app-events.md).

A chat client gets the chat as its user sees it, `MyAssistant.subscribeView(chatId)`
(a `ChatView`): the messages, their blocks (with a decision's preview and
outcome), and whether the assistant or a specialist is working. Never the
model's output, tool calls, or results; `subscribe` streams the whole log,
for the server. See [the chat client](../../apps/docs/guide/client.md).
`MyAssistant.delete(chatId)` deletes a chat: its log, and what works in it.

A long chat can be compacted: the model then reads a summary instead of
everything before it, while the log keeps it all. The app decides when and
how. Its handler reads the chat's entries, has a model write the summary,
stores it as one of
its own events, and reads the chat with `Compaction.since`: the summary, what
is still open (decisions waiting, unanswered blocks, running specialists,
read from the log), then the entries after it. See
[compaction](../../apps/docs/guide/compaction.md).

Docs: [`apps/docs`](../../apps/docs) (`pnpm docs:dev`). Start with the
[introduction](../../apps/docs/guide/introduction.md), or go straight to the
[API reference](../../apps/docs/api/index.md), generated from this package's
JSDoc.

```bash
pnpm --filter effect-assistant test            # the mechanics, on a scripted model
pnpm --filter effect-assistant test:contract   # against the real model (ANTHROPIC_API_KEY in .env.local)
pnpm --filter effect-assistant build       # vp pack: dist, with declarations and source maps
```

## Migrating from effect-uai

The library used to run on `@effect-uai/core`. It runs on `effect/unstable/ai`
now, so `@effect-uai/*` isn't a peer dependency any more.

- **The model is the `LanguageModel` in context.** `model` is gone from
  `turn.loop`, `run.loop`, `turn.replyIfOwed`, and `AssistantLoop.step` /
  `stream`. Provide one to the assistant's layer instead of
  `Anthropic.layer({ apiKey })`:
  `AnthropicLanguageModel.model("claude-sonnet-5")` with
  `AnthropicClient.layer({ apiKey })` and an `HttpClient`. A specialist
  whose layer is given its own `LanguageModel` uses that one.
- **Prompt caching** is the provider's setting:
  `Anthropic.layer({ promptCaching: true })` becomes
  `AnthropicLanguageModel.model(name, { cache_control: { type: "ephemeral" } })`,
  one request-level breakpoint that Anthropic moves to the last block, as
  before. Many strict tools can make Anthropic refuse the request ("compiled
  grammar is too large"); `strictJsonSchema: false` turns strict tools off,
  and params that don't fit are then a failure the model reads.
- **Tools are native.** `Tool.make({ name, description, inputSchema, run })`
  becomes `Tool.make(name, options)` from `effect/unstable/ai/Tool`, with
  `description`, `parameters`, `success`, `failure`, and `dependencies`, and
  its `run` becomes a handler: `Toolkit.make(...).toLayer({ name: (params) => ... })`, or inline
  with `AssistantLoop.tools(toolkit, handlers)`. A tool now declares its
  `success` schema (the default is `Schema.Void`). Services a handler uses at
  call time (`AssistantChat`, `AssistantToolCall`, the app's user) are its
  tool's `dependencies`; services its layer has, it yields in the layer's
  build.
- **Toolkits go through `AssistantLoop.tools`.** `turn.loop({ toolkit })`
  and `run.loop({ toolkit })` take `AssistantLoop.Tools`:
  `AssistantLoop.tools(yield* MyToolkit)` in the build (with the handlers'
  layer provided), `AssistantLoop.tools(MyToolkit, handlers)`, or
  `AssistantLoop.tools(MyToolkit)` when the loop has the handlers' layer.
  `{ ...a, ...b }` and `Toolkit.compose(a, b)` become
  `AssistantLoop.merge(a, b)`; `turn.tools` is an `AssistantLoop.Tools` too.
  `ToolDiscovery.make` and `Skill.toolkit` take and return them.
- **`Tool.fail(message, { kind })`** becomes
  `ToolFailure.fail(message, { kind })`, with `failure: ToolFailure.ToolFailure`
  on the tool. Any failure of a tool is still a result the model reads, and
  params that don't fit its schema are a `ToolFailure` of kind
  `ToolParameterValidationError`. `AssistantLoop.ToolErrors` is gone: tools
  never fail the loop, only a defect does.
- **History is `Prompt.Message`s.** `turn.history()`, `run.history`, and a
  history view's extra items are `effect/unstable/ai/Prompt` messages
  instead of `Items.HistoryItem`s: `Items.userText(text)` becomes
  `...Prompt.make(text).content`.
- **The stored forms changed**: `ModelOutput.items` is `parts` (native response parts, with
  the call's `model`, `responseId`, `usage`, and `durationMillis`), and
  `ToolResult.output` (text) is `result` (the encoded result in JSON) with
  `outcome` (`"success"` or `"failure"`) and a failure's `kind`. Logs written
  with the old forms don't decode.
- **Your own loop** uses `AssistantLoop.loop`, `value`, `next`, and `stop`
  instead of effect-uai's `Loop`.
