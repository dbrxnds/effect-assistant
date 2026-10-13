---
"effect-assistant": minor
---

The library no longer owns approvals: `Decision` is gone, and so are parked tool calls. Who acts decides how the user is involved:

- **The assistant acts**: it calls a tool with final values. A tool that changes things stays safe to run twice with `AssistantToolCall.idempotencyKey`, for example as a workflow's idempotency key.
- **The user acts**: a block without an `answer` schema shows what to do, and its button calls your app's own API (an RPC, a route) with exactly the props it shows. The API does the work and tells the chat with one of your events, registered with `AppEvent.make(schema, { wakes: true })` and stored with `assistant.submit(chatId, event)`, so the assistant follows up.
- **The user answers**: a block with an `answer` schema, whose `BlockAnswer` the model reads. The user may also just type.

A tool with Effect's `needsApproval` set is refused, never run: a loop with one (`turn.loop`, `AssistantLoop.run` and `step`, a specialist's `run.loop`) fails before it calls the model, naming the tools, and so a turn fails and a specialist's run reports `failed`. `ToolDiscovery.layer` over a catalog with one fails when it's built.

Breaking changes, and how to migrate:

- **`Decision` and `DecisionId` are gone**, and so are `AssistantEvent.DecisionOutcome`, `CallOrigin`, `DecisionRequested`, and `DecisionResolved`. `AssistantLoop.Event` is a `ModelOutput`, a `ToolStarted`, or a `ToolResult`. A log written by 0.1 reads its decision events as app events the assistant didn't register, and a call still parked there has no result, so the chat's next turn runs it like a call a crash cut off: with the tool taken out of the toolkit, it fails as a tool that doesn't exist; a tool you keep runs it.
- **`needsApproval` + `Decision.block`**: remove `needsApproval` from the tool and `Decision.block` from the kit. If the assistant may do it alone, keep the tool: the model calls it with final values. Otherwise, take the tool out of the toolkit, and give the assistant a block without an answer that shows the work (`Block.make("order_draft", { description, props })`, its props what the tool's params were, plus what the user should see, like a total). Its button calls your API, which checks again (the budget may have moved), does the work once per block (key it on the chat and the block's message id, which a renderer now gets as `messageId`), and submits a waking event like `OrderPlaced`. Tell the model in the block's description that only the user does it, with the button.
- **`Decision.durable` and `Decision.request`**, from before 0.1.0 (they were removed when decisions became tool calls only), have the same replacement. Work that needs the user reports it with a waking event that says what it needs, and the assistant shows a block: one with an `answer` schema for a question, or one without whose button calls your API for a commitment. The API resumes the work (for a workflow waiting on a `DurableDeferred`, it completes it) and tells the chat.
- **`ChatView.PendingDecision` is gone, and so is a block's `decisions`** in the view. `BlockKit.RenderArgs` has no `decisions`, and `BlockKit.closeStale` closes every stale block.
- **`Compaction.openItems`** lists blocks the user hasn't answered and specialists still working; there are no decisions waiting.
- **`ToolDiscovery`'s `execute_tool`** no longer fails with reason `"NeedsDecision"`: the layer refuses such tools when it's built.
