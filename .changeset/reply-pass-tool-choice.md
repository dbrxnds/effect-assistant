---
"effect-assistant": patch
---

The reply pass requires a tool call. It runs when the model wrote text of its own instead of replying, and with `auto` it could do so again and end the turn as failed. Changing the tool choice re-reads the history at full price, only on those turns.
