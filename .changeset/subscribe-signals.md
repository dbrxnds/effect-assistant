---
"effect-assistant": minor
---

`subscribe`'s `live` option is now `signals`: `assistant.subscribe(chatId, { signals: true })` streams the chat's signals with its entries. The cluster's `Subscribe` RPC payload field is renamed the same way.
