# Engines

An engine runs every assistant's chats. Pick one for the app, like Effect's
workflow engine: `AssistantEngine.layerMemory` runs chats in the process, and
`AssistantEngine.layerCluster` runs each chat as a cluster entity.

**Example** (The in-memory engine)

```ts
import { AssistantEngine, ChatLog } from "effect-assistant"
import * as Layer from "effect/Layer"

const MyAssistantLive = MyAssistantHandlers.pipe(
  Layer.provide(ModelLive), // the LanguageModel
  Layer.provideMerge(AssistantEngine.layerMemory),
  Layer.provideMerge(ChatLog.layerMemory)
)
```

The definition and the handler don't change with the engine. Each
assistant's `toLayer` registers with it, and both engines run one turn per
chat at a time. Both need an [event log](./events#storage).

## In memory

`AssistantEngine.layerMemory` runs each chat's turns as fibers in the
process, one at a time. Pair it with the memory log for tests, or the SQL log
to keep chats across restarts.

With the SQL log, it resumes at startup. When an assistant registers, it
finds the chats it was working on when the process stopped (a turn cut off
mid-way, or an input no turn read) and runs a turn. The log keeps every
step, so the turn goes on from the last one recorded.

::: warning One process
Run `layerMemory` in one process only. Two would run the same chat and write
its log at once.
:::

## As cluster entities

`AssistantEngine.layerCluster` runs each chat as an entity in an
Effect cluster, keyed by chat id.

- `submit` sends the entity a **persisted** message and returns. The entity
  stores the input, then runs turns until nothing is pending.
- A crash mid-turn leaves the message unprocessed, so the cluster
  **redelivers** it and the work resumes.
- `subscribe` and `subscribeView` stream from the entity, which is where the
  events are written, and `delete` goes to it, so the entity stops what
  works in the chat.
- The chat's [specialist](./specialists) runs live in its entity, which
  keeps itself alive while they, or turns for their answers, work. When an
  entity starts, it runs a turn for any input no turn has read.
- An entity with no work and no subscribers stops after 5 minutes.

It needs `Sharding`: a `SingleRunner` for one process with SQL storage, or
`TestRunner` in tests. [Deploying](./deploying) shows the wiring.

## What's durable

|                               | `layerMemory`                      | `layerCluster`                    |
| ----------------------------- | ---------------------------------- | --------------------------------- |
| Chat log                      | with the SQL log                   | with the SQL log                  |
| A turn interrupted by a crash | resumed at startup (one process)   | resumed on redelivery             |
| Specialist runs               | in memory; cut off on restart      | in memory; cut off on restart     |
| The turn for a cut-off run    | runs at startup                    | runs when the entity starts again |
| Workflows started by tools    | with the workflow engine's storage | same                              |

Specialist runs are in memory with both: they're quick helpers. A run cut
off by a shutdown answers that it was, so the assistant is told and can
spawn it again. Put durable work in a [workflow](./app-events#long-running-work).
