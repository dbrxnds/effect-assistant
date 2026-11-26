---
"effect-assistant": minor
---

A tool's status field is now an optional `activity` parameter, and the line goes when its call ends.

- `ToolStatus.withStatus` adds `activity` instead of a required `description`. The model leaves it out when there's nothing worth showing, and the call runs either way.
- When the last described call ends, the chat sends the new `ChatSignal.StatusCleared`, and the timeline's `activity.status` goes back to `undefined`. While another described call runs, the line says that one.
- A status summary that repeats the line just cleared isn't shown.

Rename the field in handlers and in tests that call these tools: `{ description: "…" }` becomes `{ activity: "…" }`.
