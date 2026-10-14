# Skills

A [`Skill`](/api/Skill) is a playbook: step-by-step instructions for a kind of
task. Long playbooks would crowd the prompt, so skills are a tool:
[`Skill.toolkit(skills)`](/api/Skill#toolkit) is a toolkit with one tool,
`load_skill`. Its description is the **catalog**, each skill's name and
description ("use when…"), and the model calls it to read a skill's
instructions when a task matches. They then stay in the history for the rest
of the work.

**Example** (A playbook for ordering campaigns)

```ts
import { Skill } from "effect-assistant"
import * as Layer from "effect/Layer"
import * as Toolkit from "effect/ai/Toolkit"

const orderingCampaigns = Skill.make("Ordering a campaign", {
  description: "Use when the user wants to order or start a campaign.",
  instructions: `1. Pick the product with list_campaign_products.
2. You need who it should reach and a budget. Ask for what's missing, one question at a time.
3. When you have both, call start_campaign.`
})

const AssistantSkills = Skill.toolkit([orderingCampaigns, sharingAssets])

const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.run({ instructions, toolkit: Toolkit.merge(CampaignTools, AssistantSkills) })
).pipe(Layer.provide([CampaignToolsLive, AssistantSkills.layer]))
```

It's a toolkit like any other: merge it into the loop's own with
`Toolkit.merge`, and provide its `layer`, which has `load_skill`'s handler.
Write each description as a trigger ("Use when…"): it's all the model sees
until it loads the skill. A name that isn't in the list is a failure the
model reads, with the names there are.

A skill says how to do a kind of task, not what the model may do: what it
can do is its toolkit. A playbook whose tools a loop doesn't have still
loads; the model works with the tools it has.

## Skills per user

The handler resolves only the skills of its own list. To offer each user the
skills their role allows, build the toolkit in the turn from that user's
list, and provide its layer to the loop's stream. Building one does no work.

**Example** (Skills by role)

```ts
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  Stream.unwrap(
    Effect.map(roleOf(turn.chatId), (role) => {
      const skills = Skill.toolkit(allSkills.filter((skill) => allowed(role, skill)))

      return turn
        .loop({ instructions, toolkit: Toolkit.merge(CampaignTools, skills) })
        .pipe(Stream.provide(skills.layer))
    })
  )
)
```

Skill instructions can be [managed prompts](./instructions): an Effect is
resolved each time the skill is loaded. The services it needs are what the
toolkit's `layer` requires: provide them with the layer, or, for a toolkit
built per turn, to the loop's stream, like a user the handler
[looked up](./chats). A specialist's `run.loop` takes the same toolkit.

## Skills, tools, or specialists?

- A **tool** does something: look up, start, change.
- A **skill** says how to do a kind of task with the tools you have.
- A **specialist** does a task on its own, in the background, with its own
  tools and instructions.
