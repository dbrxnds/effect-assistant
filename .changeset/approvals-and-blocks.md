---
"effect-assistant": minor
---

Approval and block fixes.

- An approval waits only beside a message the user got. When the step's message fails, the approval call fails with `ApprovalNeedsMessage`, and the model gets a step to send both again.
- A message that `closes` an earlier card withdraws the approvals asked beside that card: they expire, and won't run.
- A tool call that writes an object or list parameter as a JSON string still runs, once the string is parsed.
