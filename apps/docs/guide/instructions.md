# Instructions and prompts

An assistant's instructions are what its handler passes to `turn.loop` (a
specialist's, to `run.loop`): text, or [`Instructions.Resolved`](/api/Instructions)
(text with span attributes).

**Example** (Fixed instructions)

```ts
const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({ instructions: "You are a colleague on the marketing team." })
)
```

The library adds only what the loop needs to work, `Instructions.protocol`:
every step is a tool call, a last message with `wait: true` (or `wait`) ends
the turn, and messages can arrive mid-turn. The rest the model learns where it applies: `send_user_message`'s
description says the user sees nothing else, a `<specialist>` report in
the history says what it is and that the user hasn't seen it, and your own
events read as your history view maps them (so say it there too). Who the assistant is, its voice, and what's worth telling the
user are yours to write. `turn.instructions(text)` returns the full prompt,
for a [custom loop](./loops).

## Computed every turn

The handler runs every turn, so instructions can come from anywhere: the
current version from a prompt manager (a new version goes live without a
deploy), or a prompt tailored to the chat's [user](./chats):

```ts
const MyAssistantHandlers = MyAssistant.toLayer(
  Effect.gen(function* () {
    const users = yield* ChatUsers

    return Effect.fn(function* (turn: Assistant.Turn) {
      const user = yield* users.forChat(turn.chatId)

      return turn.loop({ instructions: `You are a colleague of ${user.name} on the marketing team.` })
    })
  })
)
```

A resolved prompt can carry **span attributes**, which are added to every
model call it's used for. That's how a trace links each generation to the
prompt version behind it.

A [skill's](./skills) instructions can be an Effect too
(`Instructions.Instructions`), resolved each time the skill is loaded.

## Prompts from Langfuse

Model the prompt source as a service with two layers: one that reads from
Langfuse, and one that uses the text in code.

```ts
import { LangfuseClient } from "@langfuse/client"
import type { Instructions } from "effect-assistant"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export const defaults = {
  "my-assistant": "You are a colleague on a small marketing team…",
  "skill-ordering": "1. Pick the product…"
} as const

export class Prompts extends Context.Service<
  Prompts,
  {
    readonly get: (name: keyof typeof defaults) => Effect.Effect<Instructions.Resolved>
  }
>()("app/Prompts") {}

export const instructions: (name: keyof typeof defaults) => Instructions.Instructions<Prompts> = Effect.fn(function* (
  name: keyof typeof defaults
) {
  const prompts = yield* Prompts
  return yield* prompts.get(name)
})

export const layerDefaults = Layer.succeed(Prompts, {
  get: (name) => Effect.succeed({ text: defaults[name] })
})

export const layerLangfuse = Layer.sync(Prompts, () => {
  const client = new LangfuseClient()
  return {
    get: (name) =>
      Effect.tryPromise(() => client.prompt.get(name, { label: "production", cacheTtlSeconds: 60 })).pipe(
        Effect.map((prompt) => ({
          text: prompt.prompt,
          attributes: {
            "langfuse.observation.prompt.name": prompt.name,
            "langfuse.observation.prompt.version": prompt.version
          }
        })),
        // The Effect can't fail: fall back to the text in code.
        Effect.orElseSucceed(() => ({ text: defaults[name] }))
      )
  }
})
```

The handler gets the prompt every turn, and skills load theirs when they're
used:

```ts
const ordering = Skill.make("Ordering a campaign", {
  description: "…",
  instructions: Prompts.instructions("skill-ordering")
})

const MyAssistantHandlers = MyAssistant.toLayer(
  Effect.gen(function* () {
    const prompts = yield* Prompts

    return Effect.fn(function* (turn: Assistant.Turn) {
      return turn.loop({ instructions: yield* prompts.get("my-assistant"), skills: [ordering] })
    })
  })
)

// Tests and local dev: the text in code. Production: Langfuse.
MyAssistantHandlers.pipe(Layer.provide(process.env.LANGFUSE_SECRET_KEY ? layerLangfuse : layerDefaults))
```

The demo app does exactly this (`packages/demo/api/src/Prompts.ts`), and
has a `prompts:push` script that uploads the text in code as new versions.
