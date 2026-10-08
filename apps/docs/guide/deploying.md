# Deploying

In production, an assistant keeps its chats in SQL and runs on the cluster
engine, so chats survive restarts and a turn cut off by a crash resumes.

**Example** (One process on Postgres)

```ts
import { AssistantEngine, ChatLog } from "effect-assistant"
import * as Layer from "effect/Layer"
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine"
import * as SingleRunner from "effect/cluster/SingleRunner"

const MyAssistantLive = MyAssistant.toLayer(handler).pipe(Layer.provide(ResearchLive))

const AppLive = Server.layer.pipe(
  Layer.provideMerge(MyAssistantLive),
  Layer.provideMerge(Layer.merge(AssistantEngine.layerCluster, ClusterWorkflowEngine.layer)),
  Layer.provide(ModelLive), // AnthropicLanguageModel.model(...): the LanguageModel
  Layer.provideMerge(Layer.merge(ChatLog.layerSql, SingleRunner.layer({ runnerStorage: "sql" }))),
  Layer.provide(PgLive) // one Postgres pool for the log, the entities, and workflows
)
```

`Server.layer` is your RPC or HTTP server: it gets the assistant with
`yield* MyAssistant` and calls `submit` and `subscribe`, so the
assistant's layer is merged in where it can reach it. The
[engines](./engines) page explains what each engine does, and what survives
a restart.

The demo is wired this way: `packages/demo/api/src/main.ts` for the app,
and `Storage.ts` for the runner and the pool. Without `DATABASE_URL` it
swaps in the memory log and `TestRunner`, so it runs locally with nothing
to set up.

## One database

One `SqlClient` serves everything:

- `ChatLog.layerSql` stores the log in a `chat_log` table you create (see
  [the log](./events#storage)).
- Your [`Chats`](./chats#which-chats-exist) can read your own chat table in
  the same database.
- `SingleRunner` keeps the cluster's messages and shards in the same
  database, so a persisted `submit` survives a crash.
- `ClusterWorkflowEngine` runs the [workflows](./app-events#long-running-work)
  your tools start, on the same cluster.
- Your app's own chat table (see [chats and users](./chats)) can share the
  pool.

## At the edge

Your server is where users meet the assistant. Before it submits or
subscribes for a signed-in user, it checks the chat is theirs (see
[check access at the edge](./chats#check-access-at-the-edge)). The events
webhooks and workflows report are submitted by your server, and never come
from the client, and the client gets the chat's [view](./client), never its
log.

## One writer per chat

The log locks per chat within a process; nothing locks across processes.
The cluster engine sees to it that one process writes each chat, by sending
the chat to its entity. With `layerMemory`, run one process.
