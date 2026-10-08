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
messages, the model's calls, tool results, specialists' reports, and your
app's own events, like a workflow's progress. `submit` appends an input (a message, a block answer, or one of your events) and returns
immediately. A **turn** runs the agent loop over the log: before every model
call it rebuilds the history from the log, so anything that arrived meanwhile
is seen. The assistant can only reach you through a `send_user_message` tool, so
nothing the model writes reaches you unless it chooses to send it.

## What's in the box

| Module                                                             | What it does                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [`Assistant`](/api/Assistant)                                      | Defines an assistant: its handler, and its service (`submit`, …).       |
| [`Chats`](/api/Chats)                                              | Which chats exist: the app's, asked before inputs and model calls.      |
| [`AssistantChat`](/api/AssistantChat)                              | The chat that code runs in: its id, entries, and `append`.              |
| [`ChatView`](/api/ChatView)                                        | A chat as its user sees it: what a chat client gets.                    |
| [`AssistantEngine`](/api/AssistantEngine)                          | Runs the chats: in the process, or one cluster entity per chat.         |
| [`AssistantEvent`](/api/AssistantEvent), [`ChatLog`](/api/ChatLog) | The events, and the log that stores them (memory or SQL).               |
| [`AssistantLoop`](/api/AssistantLoop)                              | The agent loop, as a stream a handler returns, changes, or replaces.    |
| [`Specialist`](/api/Specialist)                                    | Focused agents the assistant hands work to, in the background.          |
| [`Skill`](/api/Skill)                                              | Playbooks the assistant loads when a task matches.                      |
| [`ToolDiscovery`](/api/ToolDiscovery)                              | Search-and-run for tool catalogs too big for the prompt.                |
| [`ToolFailure`](/api/ToolFailure)                                  | A tool's failure, as a message the model reads.                         |
| [`Block`](/api/Block), [`BlockKit`](/api/BlockKit)                 | Small UI in messages: options, inputs.                                  |
| [`Decision`](/api/Decision)                                        | What the user approves or declines: a parked tool call.                 |
| [`Instructions`](/api/Instructions)                                | Prompts: text, optionally with span attributes (for prompt management). |
| [`Memory`](/api/Memory), [`Compaction`](/api/Compaction)           | What it remembers across chats, and summaries for long chats.           |

It's built on [Effect](https://effect.website) (v4), with Effect's AI modules
(`effect/ai`) for model calls and tools: any `LanguageModel`
provider, and native `Tool`s.
Every module follows Effect's conventions: services, layers, and schemas.

It's a chat turn engine, not an agent framework: RAG, evals, and vector
stores are built from its parts in your app. See [Scope and non-goals](./scope).

Next: [getting started](./getting-started) builds a working assistant in one
file. The core concepts ([assistants](./assistant), [turns](./turns),
[the event log](./events), [engines](./engines)) explain what it did.
