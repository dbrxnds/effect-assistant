---
"effect-assistant": minor
---

An assistant is a service you yield, and code in a chat uses the chat itself.

- **`const assistant = yield* MyAssistant`** gives `submit`, `subscribe`, `subscribeView`, and `delete`. `MyAssistant.toLayer(...)` registers the handler and provides the service; `MyAssistant.layerClient` provides the service only, for a process that reaches chats another one runs. Calling an assistant you didn't provide is a type error, not an "isn't registered" defect at runtime.
- **`yield* CurrentChat`** is the chat that code runs in: its `chatId`, its `entries` (the assistant's own events decoded), and `append(...events)` (encoded). A handler, a tool, and a specialist's run all get it.

Breaking changes, and how to migrate:

- `MyAssistant.submit(chatId, input)` becomes `(yield* MyAssistant).submit(chatId, input)`, or `MyAssistant.use((assistant) => assistant.submit(...))`; the same for `subscribe`, `subscribeView`, and `delete`. Provide the assistant's layer with `Layer.provideMerge` where those callers run.
- `turn.entries` and `turn.append` are gone: `const chat = yield* CurrentChat.CurrentChat`, then `chat.entries` and `chat.append(...)`. Entries carry your events decoded but untyped: read them with `Schema.is(MyEvent)` or `instanceof`.
- `CurrentChat.append` takes events as arguments, not an array, and returns nothing.
