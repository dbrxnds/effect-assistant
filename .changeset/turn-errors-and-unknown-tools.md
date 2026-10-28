---
"effect-assistant": minor
---

A failed turn is reported to Effect's `ErrorReporter`, so it reaches any reporter an app provides. Before, it was only logged and stored as `TurnFailed`.

A tool call the model makes to a tool the turn doesn't offer no longer fails the turn. This happens when a tool from earlier in the chat has since been removed, or a policy now filters it out. The call runs like any other: it fails with `No tool named …`, and the model reads that and goes on. The loop's model call now runs with `disableToolCallResolution: true` and `toolCallValidation: "deferred"`. Before, the model call failed with `Invalid output`, and so did every later turn in that chat.

`effect` must now be 4.0.4 or later, the first version with deferred tool call validation.
