---
"effect-assistant": minor
---

Live status and typing for a chat, sent only to the subscribers that are listening and never stored.

- `assistant.subscribe(chatId, { live: true })` streams the chat's signals between its entries, in order: `ChatSignal.StatusShown`/`StatusCleared` say what the running turn is doing, `TypingStarted`/`TypingStopped` say when the model is writing a message to the user. A turn clears what it showed before its `TurnCompleted` or `TurnFailed`, also when a tool fails mid-call.
- `ToolStatus.described(tool)` marks a tool whose calls show a status: the model sees an optional `description` parameter on it and writes 3 to 8 words in the user's language; the chat shows them while the call runs. The handler never gets the parameter.
- `StatusSummary.layer({ after, every })`, on a small model of its own, writes a few words about a turn that has worked a while with nothing else to show. It never shows after the turn's message unless the model starts new work.
- `Timeline.changes` folds the signals into `activity.status` and `activity.typing`. `Timeline.Activity` has a required `typing` field now.
- The loop streams its model calls (`LanguageModel.streamText`), so its spans are `LanguageModel.streamText`. A span transformer gets the streamed parts as its `response`.
