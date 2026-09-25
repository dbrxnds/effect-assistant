---
"effect-assistant": minor
---

An open chat reads its log once and keeps its entries in memory, so a turn no longer reads the log. `ChatLog.read(chatId, { after })` and `subscribe(chatId, { after })` read or stream only what comes after a `seq`, for a client that reconnects.
