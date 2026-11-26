---
"effect-assistant": minor
---

Status means whether the assistant is working, and activity means what it's doing right now.

- `Timeline.Activity` is now `Timeline.Status`, and a timeline's `activity` field is now `status`. The line about what the running turn does moves from `status.status` to `status.activity`.
- `ChatSignal.Status` is now `ChatSignal.Activity`, with the tag `"Activity"`.
- `AssistantActivity` is now `AssistantStatus`, `StatusSummary` is now `ActivitySummary`, and `ToolStatus` is now `ToolActivity`, with `withActivity`, `ActivityField`, `WithoutActivity` and `hasActivity`.
