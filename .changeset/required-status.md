---
"effect-assistant": patch
---

A described tool's `description` parameter is required in what the model reads: models left the optional one out, so calls showed no status. A call without it still runs, with no status, and the handler still never gets it.
