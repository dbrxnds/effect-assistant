---
"effect-assistant": minor
---

`ChatLog.layerSql` takes options: `ChatLog.layerSql({ table: "my_chat_log" })` stores the log in a table of that name (`chat_log` by default, `ChatLog.layerSql()`). `ChatLog.EventJson` is the schema `layerSql` stores events with, for a storage of your own passed to `ChatLog.make`.
