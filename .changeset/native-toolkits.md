---
"effect-assistant": minor
---

Loops take native toolkits. `turn.loop`, `run.loop`, `AssistantLoop.run`, and `AssistantLoop.step` take an Effect `Toolkit` as `toolkit`, with its handlers from the assistant's (or specialist's) layer: `toLayer` now requires the tools' handlers, so `Layer.provide(MyToolsLive)` gives them, and a missing one is a type error naming the tool. In a turn, `AssistantLoop.step` and `run` add the assistant's own tools to yours, so a loop of your own can message the user.

Breaking changes, and how to migrate:

- **`AssistantLoop.fromToolkit`, `merge`, `only`, `empty`, and the `Tools` type are gone.** Pass the toolkit itself (`toolkit: MyTools`) and provide its handlers' layer (`MyTools.toLayer(handlers)`); merge toolkits with `Toolkit.merge`; give a user fewer tools by building a smaller toolkit for their turn.
- **`ToolDiscovery` is a loop option**: `turn.loop({ toolkit, catalog: BigToolkit })` gives the model `search_tools` and `execute_tool` over `catalog`.
- **Memory's tools are a native toolkit**: `Memory.makeToolkit(scopes)` becomes `Memory.Tools` with `Memory.layerTools`, and the turn provides the scopes, `Stream.provideService(Memory.CurrentScopes, scopes)`.
- **Previews are gone.** A parked call has no preview: `DecisionRequested` has no `preview`, and a view's decision has the call's `tool` and `params` instead. What the user sees about a call is the app's (a lookup tool the model calls first, or the client fetching what it needs).
- **`turn.tools` and `Skill.toTools` are gone**: a loop of your own gets the assistant's tools by itself, and `skills` is a loop option.
