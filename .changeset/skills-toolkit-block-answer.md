---
"effect-assistant": minor
---

Skills are a toolkit, and a server can answer a block itself.

- **`Skill.toolkit(skills)`** is a toolkit with one tool, `load_skill`, whose description is the catalog: each skill's name and when to use it. Merge it into a loop's toolkit like any other, `Toolkit.merge(MyTools, AssistantSkills)`, and provide `AssistantSkills.layer`, the handler that resolves the skills' instructions; it requires the services they need, like any tool handler. A name that isn't in the list is a failure the model reads, with the names there are. The handler resolves only its own list, so to offer each user the skills their role allows, build the toolkit in the turn from their list and provide its layer to the loop's stream (`Stream.provide(skills.layer)`).
- **`Block.answer(block, { messageId, value })`** builds the `BlockAnswer` for a block on a message, with the value encoded by the block's answer schema and the same fixed id a client's `respond` uses. A server that acted on a block, like an API that placed the order a checkout block showed, submits it: `assistant.submit(chatId, Block.answer(OrderCheckout, { messageId, value: { orderId } }))`. The block shows as answered on the timeline, a turn wakes, and a second answer to the same block is stored once. `BlockKit.toClient`'s `respond` uses it too.

Breaking changes, and how to migrate:

- **`turn.loop` and a specialist's `run.loop` take no `skills`**, and the prompt has no skills catalog. `turn.loop({ instructions, toolkit: MyTools, skills: [a, b] })` becomes `turn.loop({ instructions, toolkit: Toolkit.merge(MyTools, Skills) })` with `const Skills = Skill.toolkit([a, b])`, and `Layer.provide(Skills.layer)` where the tools' layers are provided. A skill's instructions resolve with the services given to that layer, no longer with the loop's: provide them to the layer, or to the loop's stream for a toolkit built per turn. `Assistant.LoopOptions` and `Specialist.LoopOptions` lose their `RS` type parameter (`LoopOptions<T, Events>` and `LoopOptions<T>`), and `Skill.withCatalog` is gone.
- **`Skill.make` takes no `tools`**, and skills are no longer left out for a loop that lacks their tools: a skill says how to do a kind of task, and the model works with the tools it has. To offer a skill only to some users, build their list per turn (see above).
- **A block whose button calls your API** answers the block with `Block.answer` instead of submitting an app event of its own: give the block an `answer` schema for what the API reports (an order id), and submit its answer once the work is done.
