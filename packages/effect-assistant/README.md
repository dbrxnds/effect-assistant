# effect-assistant

A colleague assistant on Effect. You send it messages; it works in the background,
uses tools, starts long-running work, and messages you when it has something
to say. Messages you send while it works are picked up at its next step.

```ts
import { Assistant, AssistantEngine, type AssistantEvent, type ChatId, ChatLog, Specialist } from "effect-assistant"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

// Definitions: what callers and the UI need to know.
const Research = Specialist.make("research", { description: "Researches past campaigns." })

export const MyAssistant = Assistant.make("my-assistant", { blocks: Blocks, specialists: [Research] })

// Handlers: the build Effect runs once per chat activation; the function runs every turn (or brief).
const MyAssistantLive = MyAssistant.toLayer(Effect.gen(function*() {
  const prompts = yield* Prompts // from the layer
  const users = yield* ChatUsers // the app's chat table: whose chat is it

  return (turn) =>
    Stream.unwrap(Effect.gen(function*() {
      const user = yield* users.forChat(turn.chatId)

      return turn.loop({
        model: "claude-sonnet-5",
        instructions: yield* prompts.get(user),
        toolkit,
        skills: [orderingCampaigns]
      }).pipe(Stream.provideService(CurrentUser, user)) // for the tools
    }))
}))

const ResearchLive = Research.toLayer(Effect.gen(function*() {
  const users = yield* ChatUsers

  return (run) =>
    Stream.unwrap(
      Effect.map(users.forChat(run.chatId), (user) =>
        run.loop({ model: "claude-sonnet-5", instructions: "Answer in a few lines.", toolkit: researchTools })
          .pipe(Stream.provideService(CurrentUser, user)))
    )
}))

// One engine for the app: each chat is a cluster entity. Or in the process: AssistantEngine.layerMemory.
export const AppLive = MyAssistantLive.pipe(
  Layer.provide([ResearchLive, PromptsLive, ChatUsersLive, AnthropicLive]), // Anthropic.layer: the LanguageModel
  Layer.provideMerge(AssistantEngine.layerCluster),
  Layer.provideMerge(Layer.merge(ChatLog.layerSql, SingleRunnerLive))
)

// Whom a chat is for is the app's data. At the edge, check the signed-in user may use it:
const send = (userId: string, chatId: ChatId.ChatId, message: AssistantEvent.ClientInput) =>
  checkAccess(userId, chatId).pipe(Effect.andThen(MyAssistant.submit(chatId, message)))
```

Docs: [`apps/docs`](../../apps/docs) (`pnpm docs:dev`). Start with the
[introduction](../../apps/docs/guide/introduction.md), or go straight to the
[API reference](../../apps/docs/api/index.md), generated from this package's
JSDoc.

```bash
pnpm --filter effect-assistant test        # calls the real model (ANTHROPIC_API_KEY in .env.local)
pnpm --filter effect-assistant typecheck
```
