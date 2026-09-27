---
"effect-assistant": minor
---

`AssistantToolCall.destructive` is gone: a call a crash cut off always runs again, with the same id. A side effect that can't take `AssistantToolCall.idempotencyKey` goes in a workflow step or behind the user's approval.
