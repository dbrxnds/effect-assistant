---
"effect-assistant": minor
---

The chat's view is a utility over `subscribe`, not a method of the assistant's service. `subscribeView` is removed from `yield* MyAssistant` (and from `MyAssistant.layerClient`), with no compatibility alias.

Before:

```ts
const view = (chatId: ChatId.ChatId, after?: number) =>
  MyAssistant.useSync((assistant) => assistant.subscribeView(chatId, { after }))
```

After:

```ts
const view = (chatId: ChatId.ChatId, after?: number) =>
  MyAssistant.useSync((assistant) => assistant.subscribe(chatId).pipe(ChatView.updates(MyAssistant, { after })))
```

- **`ChatView.updates(definition, options?)`** is dual: `entries.pipe(ChatView.updates(MyAssistant, { after }))` or `ChatView.updates(entries, MyAssistant, { after })`. It reads which of the app's events wake a turn from the definition's `events`, so it takes the assistant, not `{ wakes }`. Any value with `events: ReadonlyArray<{ tag, wakes }>` fits (`ChatView.Definition`).
- **`after` goes to `ChatView.updates`, not to `subscribe`.** The fold reads the whole log from seq 0, because a message's view depends on earlier entries (a block answered later, a decision made later), and only skips emitting the updates up to `after`. `subscribe(chatId, { after })` would give it half a log.
- `ChatView.updates(entries, { wakes, after })` is gone; pass the assistant's definition instead.
