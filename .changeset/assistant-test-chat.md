---
"effect-assistant": minor
---

`AssistantTest` drives an assistant like a user would, for tests and evals. `AssistantTest.chat(assistant, chatId)` returns a chat whose steps (`say`, `approve`, `reject`, `answer`, or `send` for any input) wait until a turn has handled the input, and fail with a `TestChatError` when none does in time or the turn failed. Each step's chat reads what the assistant did, over the whole chat or over `step` alone: `toolsRun`, `toolCalls(tool)`, `blocks`, `approvals`, `waitingFor` and `messages`. `AssistantTest.log(entries)` reads the same from any entries.
