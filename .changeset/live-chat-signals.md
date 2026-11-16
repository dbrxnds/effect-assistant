---
"effect-assistant": minor
---

Live status and typing for a chat, sent only to the subscribers that are listening and never stored.

- `assistant.subscribe(chatId, { live: true })` streams the chat's signals between its entries, in order: `ChatSignal.Status { text }` is the line that says what the running turn is doing (the latest shows until the next, typing, or the turn's end), and `TypingStarted`/`TypingStopped` say when the model is writing a message to the user. Typing hides the line. Typing stops before the turn's `TurnCompleted` or `TurnFailed`, also when a tool fails mid-call, and the turn's end clears the line.
- `ToolStatus.described(tool)` marks a tool whose calls show a status: the model sees an optional `description` parameter on it and writes 3 to 8 words in the user's language, sent when the call starts. It stays after the call ends; while another described call still runs, the line switches to that one. The handler never gets the parameter.
- `StatusSummary.layer({ after, staleAfter })`, on a small model of its own, fills a line that stayed empty for `after` (2 s) or refreshes one unchanged for `staleAfter` (5 s), knowing which calls still run. It never replaces a running described call's status, never sends what the line says already, and never shows after the turn's message unless the model starts new work.
- `Timeline.changes` folds the signals into `activity.status` and `activity.typing`. `Timeline.Activity` has a required `typing` field now.
- The loop streams its model calls (`LanguageModel.streamText`), so its spans are `LanguageModel.streamText`. A span transformer gets the streamed parts as its `response`.
