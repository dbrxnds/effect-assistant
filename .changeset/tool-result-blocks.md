---
"effect-assistant": minor
---

Blocks that show a tool's result: `Block.fromToolResult(tool)` in a `BlockKit` gives the tool's results a `resultId` the model reads, and the model shows one with a `tool_result` block. The server checks the id against the chat's results; the timeline sends the result with the message, and `BlockKit.toClient` gives the tool's renderer the result, decoded by its success schema.

`ToolResult.ModelView` (and the typed `ToolResult.modelView`) sets what the model reads of a tool's success; the log keeps the whole success in the `ToolResult` event's new `full` field.
