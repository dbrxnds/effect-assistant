---
"effect-assistant": minor
---

Compaction helpers for apps that compact long chats themselves: `turn.request` (what the loop sends: its system prompt, tools and history, read without counting as reading the chat) and `AssistantLoop.summarize` (one model call over such a request, plus a prompt; nothing runs or is stored), `Compaction.since` (a history view from the app's last summary event: the summary, what is still open, then the entries after it), `Compaction.openItems` and `Compaction.inputTokens`. A re-run `send_user_message` is sent once, decision blocks never go stale, and `AssistantEngine.layerCluster` reaches chats from nodes that don't host them.

Breaking changes, and how to migrate:

- **Tool choice is `auto`.** `turn.loop` no longer forces a tool call, and the reply pass no longer forces `send_user_message` (newer models and extended thinking reject forced tool choice). A step without a tool call ends the loop. A custom loop that relied on `"required"` passes it itself.
- **Unsent text gets the reply pass.** A turn that ends with text the model wrote without `send_user_message` (the user never sees it) gets the reply pass with that text, and may send it or call `wait`.
- **The reply pass reads the loop's prompt.** It keeps the loop's system prompt, tools and history view, and the nudge is the last message instead of part of the system prompt; any call but `send_user_message` is refused. A handler calling `turn.replyIfOwed` itself gets the same.
- **No running-specialists list in the system prompt.** `turn.instructions` no longer appends "Running now"; the model reads each start in its spawn call's result.
