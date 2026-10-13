# Skills

A [`Skill`](/api/Skill) is a playbook: step-by-step instructions for a kind of
task. Long playbooks would crowd the prompt, so a handler gives its loop
skills as a **catalog**: each skill's name and description ("use when…") are in the
prompt, and a `load_skill` tool returns a skill's instructions when a task
matches. They then stay in the history for the rest of the work.

**Example** (A playbook for ordering campaigns)

```ts
import { Skill } from "effect-assistant"

const orderingCampaigns = Skill.make("Ordering a campaign", {
  description: "Use when the user wants to order or start a campaign.",
  instructions: `1. Pick the product with list_campaign_products.
2. You need who it should reach and a budget. Ask for what's missing, one question at a time.
3. When you have both, call start_campaign.`
})

const MyAssistantHandlers = MyAssistant.toLayer((turn) => turn.loop({ instructions, skills: [orderingCampaigns] }))
```

Write the description as a trigger ("Use when…"): it's all the model sees
until it loads the skill.

## Skills that need tools

A playbook that calls tools is no use to a loop without them. Give the skill
its `tools`, and a loop whose toolkit lacks any of them leaves it out: it's
not in the catalog, and `load_skill` doesn't know it. A handler that gives
each user the tools their role allows can pass every skill, and each loop
offers the ones it can follow.

**Example** (A playbook only for loops that can start a campaign)

```ts
const orderingCampaigns = Skill.make("Ordering a campaign", {
  description: "Use when the user wants to order or start a campaign.",
  instructions: `1. Pick the product with list_campaign_products.
2. When you know who it should reach and the budget, call start_campaign.`,
  tools: [ListCampaignProducts, StartCampaign]
})

const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({
    instructions,
    // A viewer's toolkit has no start_campaign, so their loop leaves the skill out.
    toolkit: canOrder ? CampaignTools : ReadOnlyTools,
    skills: [orderingCampaigns]
  })
)
```

Tools match by name, and the assistant's own (`send_user_message`, `wait`,
and the specialists') count. A tool that only
[`ToolDiscovery`](./tools) finds isn't in the toolkit, so it doesn't count.
A skill without `tools` is always offered.

Skill instructions can be [managed prompts](./instructions): an Effect is
resolved each time the skill is loaded, with the services the handler
provides to its loop (like a user it [looked up](./chats)), so a skill can be
tailored to the user. A specialist's `run.loop` takes `skills` the same way.

## Skills, tools, or specialists?

- A **tool** does something: look up, start, change.
- A **skill** says how to do a kind of task with the tools you have.
- A **specialist** does a task on its own, in the background, with its own
  tools and instructions.
