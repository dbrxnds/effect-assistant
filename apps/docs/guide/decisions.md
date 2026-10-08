# Decisions

Some things the assistant can't do on its own: place an order, publish a
post, spend a budget. The user decides. [`Decision`](/api/Decision) is how:
one primitive, asked for from two places, answered one way.

- **Before a call.** A tool that needs the user's decision doesn't run when
  the model calls it. The call is parked, and the model is told it waits.
- **During work.** Something already running, like a workflow, asks for a
  decision and waits for it.

Either way the library never asks the user itself. The model writes the
message, as it writes every message, and puts a decision
[block](./blocks) on it. Only the user's answer to that block decides.

Only what the user must approve needs a decision. A plain choice, like which
office or which product, stays an ordinary block.

## A tool that needs a decision

Mark the tool with Effect's `needsApproval`: `true`, or a function of its
params (`(params) => params.amount > 100`, or an Effect of a boolean).

```ts
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import { AssistantChat, AssistantToolCall, ToolFailure } from "effect-assistant"

const OrderInput = Schema.Struct({ office: Schema.String, product: Schema.String, quantity: Schema.Int })

export const OrderProducts = Tool.make("order_products", {
  description: "Order branded products for an office. It waits for the user's decision.",
  parameters: OrderInput,
  success: Schema.Struct({ reference: Schema.String }),
  failure: ToolFailure.ToolFailure,
  dependencies: [AssistantChat.AssistantChat, AssistantToolCall.AssistantToolCall],
  needsApproval: true
})
```

Give it a preview: what the user must see before they decide, like the
order's total and the budget left. It's an Effect of the call's params, run
when the call is parked, with the services the tool declares. Previews go
with the toolkit, in the handler's build:

```ts
import { AssistantLoop } from "effect-assistant"

const MyAssistantLive = MyAssistant.toLayer(
  Effect.gen(function* () {
    const orders = yield* Orders

    const toolkit = AssistantLoop.fromToolkit(yield* OrderTools, {
      previews: {
        // A ToolFailure goes to the model instead ("Berlin has $200 left"), and nothing waits.
        order_products: (order) => orders.quote(order)
      }
    })

    return (turn) => turn.loop({ instructions, toolkit })
  })
)
```

When the model calls `order_products`, the loop runs the preview and records
a `DecisionRequested` for the call. The model reads it as the call's result:

```json
{
  "status": "waiting_for_decision",
  "decisionId": "decision:6f1c…",
  "preview": { "product": "Cotton tote", "quantity": 300, "total": 930, "remainingBudget": 5440 },
  "next": "Not run: it runs only if the user approves it. Send them a message with a decision block …"
}
```

A parked call doesn't end the turn, even next to `send_user_message` with
`wait: true`: the model reads that it waits, and asks.

- **Approved**: the turn's next step runs exactly that call, with the params
  the model gave it and the same call id, so
  [`AssistantToolCall.idempotencyKey`](./tools#tools-that-change-things) is
  the same too. The model reads its result as the decision's.
- **Declined**: the call never runs, and the model reads that it didn't.

The user decided on the preview; things may have changed since. The tool can
still refuse when it runs, like any tool: an order checks the budget again,
and fails with a `ToolFailure` the model reads.

## The decision block

Put `Decision.block` in the assistant's blocks. An assistant whose tools can
wait for a decision must have it; its turn fails otherwise, saying so.

```ts
import { BlockKit, Decision } from "effect-assistant"

export const Blocks = BlockKit.make([ChooseOne, Decision.block])
```

The model sends it like any block, for one decision or several (one
message can ask to place three orders):

```ts
send_user_message({
  text: "300 cotton totes for Berlin come to $930, leaving $5,440. Place the order?",
  wait: true,
  block: { kind: "decision", props: { decisionIds: ["decision:6f1c…"], approveLabel: "Place order" } }
})
```

A decision block may only ask for decisions that wait: an id that doesn't is
a failure the model reads (kind `not_waiting_for_decision`).

On the client, render it with the rest of the kit. The block's props only
have ids; the [chat's view](./client) has each decision the block asks for,
with its preview and how it was decided, and its renderer gets them as
`decisions`. (A parked call's params and the model's reading of it stay on
the server.) `Decision.answerAll` is the answer an Approve or Decline button
sends. On the server, [`Decision.fromEntries`](/api/Decision#fromentries) folds the
same from a log.

```tsx
const render = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
  choose_one: ({ props, respond }) => …,
  decision: ({ props, decisions, open, respond }) => (
    <>
      {decisions.map((decision) => (
        <Preview key={decision.id} value={decision.preview} />
      ))}
      <button disabled={!open} onClick={() => respond(Decision.answerAll(props, "approved"))}>
        {props.approveLabel ?? "Approve"}
      </button>
      <button disabled={!open} onClick={() => respond(Decision.answerAll(props, "declined"))}>
        {props.declineLabel ?? "Decline"}
      </button>
    </>
  )
})
```

The answer is a `BlockAnswer` like any other, submitted the same way. The
chat takes answers one at a time and refuses (doesn't store) one that:

- answers a block that's closed,
- doesn't decide exactly the decisions its block asks for, or
- decides one that's already decided, by this block or another.

So two answers, or two tabs, decide a decision once. For each decision an
answer decides, the chat records a `DecisionResolved`. An answer is an input
from the user, so it wakes a turn, and the turn owes a reply.

If the user answers in words ("yes, go ahead"), nothing is decided: the
model can send the decision block again.

## A decision that work asks for

A workflow asks with [`Decision.durable`](/api/Decision#durable), and waits:
it suspends until the user answers, across restarts, and resumes with the
outcome.

```ts
import { Decision } from "effect-assistant"

const CreateCampaignLive = CreateCampaign.toLayer(
  Effect.fn(function* (payload) {
    const outcome = yield* Decision.durable(MyAssistant, {
      chatId: payload.chatId,
      name: "approval", // tells this workflow's decisions apart
      source: "workflow:CreateCampaign",
      preview: { campaign: payload.name, office: payload.office, budget: payload.budget }
    })

    if (outcome === "declined") return yield* CampaignFailed.make({ reason: "declined" })
    // ...
  })
)
```

The request is an input: it wakes a turn, and the model reads it as
`<decision id="…" source="workflow:CreateCampaign" status="requested">`,
with the preview, and asks with a decision block. When the user answers, the
chat completes the workflow's deferred, then records the `DecisionResolved`.
It needs the `WorkflowEngine` for that: provide it to the assistant's layer
(the same one the workflow runs on). A workflow's request to an assistant
without one fails.

From app code that isn't a workflow, [`Decision.request`](/api/Decision#request)
stores the request (once per `key`) and returns its id, and
[`Decision.outcome`](/api/Decision#outcome) waits for the answer, from the log.

## Specialists

A specialist has no user to ask, so it can't park a call: a specialist's call
to a tool that needs a decision fails (kind `needs_decision`), and the
specialist reports what needs deciding. The assistant then asks, or calls
the tool itself. A specialist's tool can still `Decision.request` a decision
for the chat: the assistant's turn asks for it.

`execute_tool` ([discovery](./tools#many-tools-discovery)) doesn't run a
tool that needs a decision either: keep those in the toolkit itself.

## What the log keeps

| Event               | Meaning                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DecisionRequested` | A decision's `id`, where it's from (`origin`: the parked call, with its tool and params, or the work's `source`), and its `preview`. |
| `BlockAnswer`       | The user's answer: `{ decisions: { [id]: "approved" \| "declined" } }`, on the message with the decision block.                      |
| `DecisionResolved`  | A decision made: its `outcome`, and the answer that made it.                                                                         |

An approved call then runs as any call does: `ToolStarted`, then its
`ToolResult`. A restart between an answer and its resolution resolves it
when the chat opens again; a restart while an approved call runs runs it
again, with the same id, like any call a crash cut off.

A [custom loop](./loops) on `AssistantLoop.step` gets the same: in a turn,
a step runs the approved calls before it calls the model.
