---
"effect-assistant": minor
---

`AssistantChat` is the chat code runs in: its id, its entries, and its writer. It replaces `AssistantTurn`, and turns no longer get the `ChatLog`. Ids are UUIDs from Effect's `Random`: `ChatId.make`, `RunId.make`, and `InputId.make` are Effects, and `InputId.fromKey` takes a key as the id. `Runner.spawn` takes no turn, and block props and answers are service-free codecs (`Block.Codec`).
