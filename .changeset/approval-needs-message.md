---
"effect-assistant": minor
---

A call that needs approval is only sent for approval with a message beside it. The approval shows the call, not what it does, so a step that calls such a tool without `send_user_message` gets a failure for that call (`ApprovalNeedsMessage`) and the model sends both.
