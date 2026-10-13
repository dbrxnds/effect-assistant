# Involving the user

Some things the assistant shouldn't do on its own: place an order, publish a
post, spend a budget. The library doesn't own approvals. Who acts decides
how the user is involved, and there are three ways:

1. **The assistant acts.** It calls a tool with final values.
2. **The user acts.** A [block](./blocks) without an answer shows what to do,
   and its button calls your app's API. The app tells the chat what happened.
3. **The user answers.** A block with an answer schema asks something; the
   answer goes to the model, and the user may also just type.

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

## The user acts

The assistant prepares the work and shows it in a block with no `answer`
schema. The block's button calls your API with exactly the props it shows,
so the user commits to what they saw. Your API does the work and submits one
of your [events](./app-events) that wakes a turn, so the assistant follows
up.

**Example** (Placing an order the assistant prepared)

```ts
import { AppEvent, Assistant, Block, BlockKit, InputId } from "effect-assistant"
import * as Schema from "effect/Schema"

export const OrderDraft = Block.make("order_draft", {
  description: "An order ready to place, with a Place order button. Only the user places it.",
  props: Schema.Struct({ product: Schema.String, quantity: Schema.Int, total: Schema.Finite })
})

class OrderPlaced extends Schema.TaggedClass<OrderPlaced>()("OrderPlaced", {
  id: InputId.InputId,
  messageId: Schema.String,
  reference: Schema.String
}) {}

export const Shop = Assistant.make("shop", {
  blocks: BlockKit.make([OrderDraft]),
  events: [
    AppEvent.make(OrderPlaced, {
      wakes: true,
      render: (placed) => `The user placed the order on your message ${placed.messageId}: ${placed.reference}.`
    })
  ]
})
```

The model sends the block like any other:

```ts
send_user_message({
  text: "300 cotton totes come to $930.",
  wait: true,
  block: { kind: "order_draft", props: { product: "Cotton tote", quantity: 300, total: 930 } }
})
```

On the client, the renderer gets the props and the id of the message the block is on, and
calls your API. A block without an answer schema has nothing to `respond` with:

```tsx
const render = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
  order_draft: ({ messageId, props }) => (
    <button onClick={() => placeOrder({ chatId, messageId, order: props })}>Place order</button>
  )
})
```

Your API (an RPC, a route) checks what it needs to, places the order once per
block, and tells the chat:

```ts
const placeOrder = Effect.fn(function* (chatId: ChatId.ChatId, messageId: string, order: typeof OrderDraft.props.Type) {
  // One order per block: a second click finds the first.
  const runId = RunId.fromKey(`order:${chatId}:${messageId}`)
  const reference = yield* placeOnce(runId, order)

  yield* Shop.use((shop) =>
    shop.submit(chatId, OrderPlaced.make({ id: InputId.fromKey(`placed:${runId}`), messageId, reference }))
  )

  return { reference }
})
```

The event's id is the order's, so it's stored once however often the button
is clicked. The model reads it as the event's `render` says, and replies
with the reference. Things may have changed since the block was shown: the
API can refuse (over budget, say), and the user sees why on the block.

The demo does this for orders and campaigns: `OrderDraft` and
`CampaignDraft` in `packages/demo/shared/src/Blocks.ts`, `PlaceOrder` and
`StartCampaign` in its RPCs, and `OrderPlaced` in
`packages/demo/api/src/OrderPlaced.ts`.

## The user answers

A block with an `answer` schema asks the user something: which office, a
date, yes or no. The answer is a `BlockAnswer`, an input the model reads,
and the turn owes a reply. The user can type the answer instead, and the
model closes the block. See [UI blocks](./blocks).

An answer is information for the model, not a commitment: what the model
does with it is its own tool call, with final values.

## Not `needsApproval`

Effect's `needsApproval` asks the caller to park a call until someone
approves it. The library doesn't: a loop with such a tool fails before it
calls the model, a specialist's run with one fails, and so does a
[`ToolDiscovery`](./tools#many-tools-discovery) layer over a catalog that
has one, each naming the tools. Remove `needsApproval`, and make the tool
something the assistant may do, or put the commitment behind a block and
your API.
