# Involving the user

Some things the assistant shouldn't do on its own: place an order, publish a
post, spend a budget. Who acts decides how the user is involved, and there
are three ways:

1. **The assistant acts.** It calls a tool with final values.
2. **The assistant acts after the user's yes.** It calls a tool that needs
   the user's approval: the call waits, the user sees it and approves or
   rejects it, and an approved call runs then.
3. **The user answers.** A [block](./blocks) with an answer schema asks
   something; the answer goes to the model, and the user may also just type.

## The assistant acts

What the assistant may do by itself is a tool, like any other. Its params
are final: the call does the work. Make it safe to run twice, since a call
a crash cut off runs again with the same id:
[`AssistantToolCall.idempotencyKey`](./tools#tools-that-change-things) is
the same every time, so a workflow keyed on it starts once.

```ts
import { AssistantToolCall, RunId } from "effect-assistant"

const RenameDraft = Tool.make("rename_draft", {
  description: "Renames a draft.",
  parameters: Schema.Struct({ draftId: Schema.String, title: Schema.String }),
  success: Schema.Struct({ runId: RunId.RunId }),
  dependencies: [AssistantToolCall.AssistantToolCall]
})

const renameDraft = (input: { readonly draftId: string; readonly title: string }) =>
  Effect.gen(function* () {
    // The workflow's idempotency key is the run id: a second run of this call finds the first.
    const runId = RunId.fromKey(yield* AssistantToolCall.idempotencyKey)
    yield* RenameWorkflow.execute({ runId, ...input }, { discard: true })

    return { runId }
  })
```

Keep this for what's fine without asking. Anything the user must agree to
goes through the next way.

## The assistant acts after the user's yes

A tool made with Effect's `needsApproval` doesn't run when the model calls
it in a turn. The call waits for the user's approval
([`ToolApproval`](/api/ToolApproval)):

- The turn records it (`ApprovalRequested`) instead of running the handler,
  gives the model a placeholder result (the call waits for the user's
  approval), and ends. The step's other calls run as usual.
- The chat's [timeline](./client#tool-calls-to-approve) shows the call, with
  its params, for the user to approve or reject.
- The user's decision is an input, like a message: built on the client with
  `ToolApproval.approve(item)` or `ToolApproval.reject(item, { reason })`,
  and submitted with the assistant's `submit`. Its id is fixed per call, so
  a double click is stored once.
- An approved call runs at the start of the next turn's loop, with the
  params the model gave it and the same call id, so
  [`AssistantToolCall.idempotencyKey`](./tools#tools-that-change-things) is
  the key the call would have had. A crash after the approval runs it again
  with that key. The model reads the result as the outcome of its earlier
  call, and replies.
- A rejected call doesn't run: the model reads that the user rejected it,
  with their reason.
- A call the user moves on from expires with
  `ToolApproval.expireStale({ messages })`, run from the handler like
  `BlockKit.closeStale`: the model reads that it wasn't approved, and a
  decision that arrives later isn't stored. So isn't one for a call that's
  already decided.

**Example** (Placing an order once the user approves it)

```ts
import { AssistantToolCall, CurrentChat, ToolApproval } from "effect-assistant"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

// Shared with the client: what the user approves.
export const PlaceOrderParams = Schema.Struct({ product: Schema.String, quantity: Schema.Int, total: Schema.Finite })

const PlaceOrder = Tool.make("place_order", {
  description:
    "Places an order. The user approves it first: your turn ends, and the outcome arrives later. Say in the same step what you're asking them to approve.",
  parameters: PlaceOrderParams,
  success: Schema.Struct({ orderId: Schema.String }),
  needsApproval: true,
  dependencies: [CurrentChat.CurrentChat, AssistantToolCall.AssistantToolCall]
})

const OrderTools = Toolkit.make(PlaceOrder)

const OrderToolsLive = OrderTools.toLayer({
  place_order: (order) =>
    Effect.gen(function* () {
      // The same key every time this call runs: one order, also after a crash.
      const key = yield* AssistantToolCall.idempotencyKey

      return { orderId: yield* placeOnce(key, order) }
    })
})

const MyAssistantLive = MyAssistant.toLayer((turn) =>
  Stream.unwrap(
    // Calls the user moved on from (two messages later) expire.
    ToolApproval.expireStale({ messages: 2 }).pipe(Effect.as(turn.loop({ instructions, toolkit: OrderTools })))
  )
).pipe(Layer.provide(OrderToolsLive))
```

A `needsApproval` function decides per call, from its params. Only a turn
can ask the user: a specialist's run that calls such a tool gets a failure
it reads, and [`ToolDiscovery`](./tools#many-tools-discovery) refuses one in
its catalog, since a call through `execute_tool` can't wait.

The user sees the call on the timeline; see
[the chat client](./client#tool-calls-to-approve) for rendering it and
sending the decision.

## The user answers

A block with an `answer` schema asks the user something: which office, a
date, yes or no. The answer is a `BlockAnswer`, an input the model reads,
and the turn owes a reply. The user can type the answer instead, and the
model closes the block. See [UI blocks](./blocks).

An answer is information for the model, not a commitment: what the model
does with it is its own tool call, and one the user must agree to waits for
their approval.
