---
"effect-assistant": minor
---

A web server reaches the cluster's chats without a log of its own, and a skill is offered only to a loop that has its tools.

- **`AssistantEngine.layerClusterClient`** reaches chats that run as cluster entities elsewhere, and runs none itself. It needs only `Sharding`, no `ChatLog`: provide it to `MyAssistant.layerClient` in a process that only submits, subscribes, and deletes, like a web server in front of the runners that use `AssistantEngine.layerCluster`. An assistant's `toLayer` can't register with it: building one dies, saying so.
- **`Skill.make(name, { description, instructions, tools })`** takes the tools a skill's instructions use. A loop whose toolkit lacks any of them, matched by name, leaves the skill out of its catalog and of `load_skill`, so a handler that gives each user the tools their role allows can pass every skill, and the model is never sent after a call it can't make. The assistant's own tools count; a tool only `ToolDiscovery` finds doesn't. A skill without `tools` is offered as before. This holds for `turn.loop` and a specialist's `run.loop`.
