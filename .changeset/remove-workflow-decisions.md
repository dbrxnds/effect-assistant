---
"effect-assistant": minor
---

Decisions are for tool calls only: `Decision.durable`, `Decision.request`, and `Decision.outcome` are removed, and so is a decision's work origin. A tool with `needsApproval` still parks its call, with its preview, until the user answers the decision block.

Breaking changes, and how to migrate:

- **Workflows don't ask the user.** Put `needsApproval` (and a preview) on the tool that starts the work, so the user approves before it starts. A workflow that needs something mid-way reports it as one of your own events that wakes a turn, and the assistant asks.
- **`DecisionRequested` isn't an input.** `submit` no longer takes one, `AssistantEvent.Input` doesn't include it, and its `origin` is always the parked call (no `Work` origin, no `token`). Logs with a work-origin request don't decode.
- **The assistant's layer no longer uses a `WorkflowEngine`.**
