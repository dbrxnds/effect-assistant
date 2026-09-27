# Skills

A [`Skill`](/api/Skill) is a playbook: step-by-step instructions for a kind of
task. Long playbooks would crowd the prompt, so a handler gives its loop
skills as a **catalog**: each skill's name and description ("use when…") are in the
prompt, and a `load_skill` tool returns a skill's instructions when a task
matches. They then stay in the history for the rest of the work.

**Example** (A playbook for ordering campaigns)

```ts
import { Skill } from "effect-assistant"

const orderingCampaigns = Skill.make({
  name: "Ordering a campaign",
  description: "Use when the user wants to order or start a campaign.",
  instructions: `1. Pick the product with list_campaign_products.
2. You need who it should reach and a budget. Ask for what's missing, one question at a time.
3. When you have both, call start_campaign.`
})

const MyAssistantHandlers = MyAssistant.toLayer((turn) => turn.loop({ instructions, skills: [orderingCampaigns] }))
```

Write the description as a trigger ("Use when…"): it's all the model sees
until it loads the skill.

Skill instructions can be [managed prompts](./instructions): an Effect is
resolved each time the skill is loaded, with the services the handler
provides to its loop (like a user it [looked up](./chats)), so a skill can be
tailored to the user. A specialist's `run.loop` takes `skills` the same way, and
`Skill.withCatalog` and `Skill.toolkit` give a custom loop the catalog and
`load_skill`.

## Skills, tools, or specialists?

- A **tool** does something: look up, start, change.
- A **skill** says how to do a kind of task with the tools you have.
- A **specialist** does a task on its own, in the background, with its own
  tools and instructions.
