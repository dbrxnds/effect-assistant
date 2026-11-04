---
"effect-assistant": patch
---

A model call's `gen_ai.prompt` span attribute is the list of prompt messages again, not that list wrapped in a serialized `Option`, so tracing backends can read it as chat messages.
