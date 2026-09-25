# Scope and non-goals

effect-assistant is a durable chat turn engine for Effect apps: the event log,
turns, chats, blocks, and specialists. It isn't an agent framework.
Effect already has most of what a framework builds itself:

| A framework builds             | effect-assistant uses                                     |
| ------------------------------ | --------------------------------------------------------- |
| A workflow engine              | `effect/unstable/workflow`                                |
| Durable runs, scaling out      | `effect/unstable/cluster` entities                        |
| A request context              | Services the handler looks up from the [chat id](./chats) |
| Model and tool adapters        | [effect-uai](https://github.com/betalyra/effect-uai)      |
| Tracing                        | Effect's OpenTelemetry support                            |
| Storage adapters               | `SqlClient`                                               |
| Retries, timeouts, concurrency | Effect                                                    |

## The rule

A feature belongs in the library only if it has to live in the turn engine or
the log to be correct. Everything else is a recipe in these docs, or code in
your app, built from services, tools, instructions, and [loops](./loops).

## In the library

- **The log as the source of truth.** The model's history, the chat UI, open
  blocks, and which inputs still need a turn are all read from it.
- **Guarantees about the log.** A turn that handles a user's message replies
  or fails; a block stays open until it is answered.
- **Turns and engines.** In memory or as cluster entities, resuming a turn
  cut off by a restart.
- **Specialists, skills, and blocks.** They change what a turn can do and what
  the log records.
- **Compaction, if it's added.** It changes how history is rebuilt from the
  log, so it can't be done well outside it. It isn't built yet.

## Not in the library

| Feature                | Where it goes                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| Working memory         | A store keyed by chat or user, a tool that updates it, and instructions that read it each turn |
| Long-term memory, RAG  | A search tool over a store you choose, scoped to the chat's user                               |
| Evals                  | Tests that drive the client from outside, like a user would                                    |
| Vector stores          | Your app                                                                                       |
| Model providers        | effect-uai                                                                                     |
| Cost caps, rate limits | A custom loop, or your RPC handler before `submit`                                             |
| A studio or dashboard  | Your tracing backend                                                                           |

When a new feature comes up, check it against the rule first. If it can be
built from the parts above, write it up as a recipe, not an option.
