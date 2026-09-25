# Introduction

effect-assistant is a library for building a **colleague** in a chat: an assistant
that works like a coworker you message, not like an endpoint you call.

A typical chatbot is turn-based. You send a message, wait, and get an answer.
While it works you can't add anything, and everything it does in between is
either shown to you or lost. A colleague is different:

- **You can keep talking.** Say "also check London" while it's still looking
  up Amsterdam, and it picks that up at its next step.
- **It works in the background.** It can start a long job (a workflow, a
  research task), tell you in one line, and follow up when there's news.
- **It decides what you need to hear.** Most progress is routine. It tells
  you about results, questions, and problems, and keeps the rest to itself.

## The idea in one paragraph

Everything that happens in a chat is an event in an **append-only log**: your
messages, the model's calls, tool results, and facts from workflows or
specialists. `submit` appends an input (a message, a block answer, or a fact) and returns
immediately. A **turn** runs the agent loop over the log: before every model
call it rebuilds the history from the log, so anything that arrived meanwhile
is seen. The assistant can only reach you through a `send_user_message` tool, so
nothing the model writes reaches you unless it chooses to send it.

## What's in the box

| Module                                                             | What it does                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [`Assistant`](/api/Assistant)                                      | Defines an assistant: `submit`, `subscribe`, and its handler.           |
| [`AssistantEngine`](/api/AssistantEngine)                          | Runs the chats: in the process, or one cluster entity per chat.         |
| [`AssistantEvent`](/api/AssistantEvent), [`ChatLog`](/api/ChatLog) | The events, and the log that stores them (memory or SQL).               |
| [`AssistantLoop`](/api/AssistantLoop)                              | The agent loop, as a stream a handler returns, changes, or replaces.    |
| [`Specialist`](/api/Specialist)                                    | Focused agents the assistant hands work to, in the background.          |
| [`Skill`](/api/Skill)                                              | Playbooks the assistant loads when a task matches.                      |
| [`ToolDiscovery`](/api/ToolDiscovery)                              | Search-and-run for tool catalogs too big for the prompt.                |
| [`Block`](/api/Block), [`BlockKit`](/api/BlockKit)                 | Small UI in messages: options, confirm, inputs.                         |
| [`Instructions`](/api/Instructions)                                | Prompts: text, optionally with span attributes (for prompt management). |

It's built on [Effect](https://effect.website) (v4) and
[effect-uai](https://github.com/betalyra/effect-uai) for model calls and tools.
Every module follows Effect's conventions: services, layers, and schemas.

It's a chat turn engine, not an agent framework: memory, RAG, and evals are
built from its parts in your app. See [Scope and non-goals](./scope).

Next: [getting started](./getting-started) builds a working assistant in one
file. The core concepts ([assistants](./assistant), [turns](./turns),
[the event log](./events), [engines](./engines)) explain what it did.
