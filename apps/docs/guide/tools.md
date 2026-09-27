# Tools

Tools are how the assistant looks things up and gets things done. They're
[effect-uai](https://github.com/betalyra/effect-uai) tools, passed to
`turn.loop` as a `toolkit`, next to the assistant's own.

**Example** (A tool)

```ts
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const ProductsInput = Schema.Struct({ category: Schema.optional(Schema.String) })

const listProducts = Tool.make({
  name: "list_products",
  description: "Products we sell, optionally in one category.",
  inputSchema: ProductsInput,
  run: Effect.fn(function* ({ category }: typeof ProductsInput.Type) {
    return [{ name: "Flyers", category: category ?? "print" }]
  })
})

const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({ model: "claude-sonnet-5", instructions, toolkit: Toolkit.make(listProducts) })
)
```

A tool is a name, a description the model reads, an input schema, and an
Effect to run. Names must be unique in a turn, including the assistant's own
tools (`send_user_message`, `wait`, `load_skill`, and the specialist tools):
a clash fails the turn.

::: tip Annotate the input
Keep the input schema in a constant and annotate `run`'s parameter with its
type (`typeof ProductsInput.Type`). Inside `Tool.make`, an `Effect.fn`
generator's parameters aren't inferred.
:::

## Tools that use services

A tool's services become the handler's requirements. State them in the
build Effect, and the layer requires them too:

```ts
const OrderHistoryInput = Schema.Struct({ office: Schema.optional(Schema.String) })

const orderHistory = Tool.make({
  name: "order_history",
  description: "Recent orders, newest first. Optionally for one office.",
  inputSchema: OrderHistoryInput,
  run: Effect.fn(function* ({ office }: typeof OrderHistoryInput.Type) {
    const orders = yield* Orders // your service
    return yield* orders.recent(office)
  })
})

const MyAssistantHandlers = MyAssistant.toLayer(
  Effect.gen(function* () {
    yield* Effect.context<Orders>() // the tools use Orders: the layer requires it

    return (turn) => turn.loop({ model: "claude-sonnet-5", instructions, toolkit: Toolkit.make(orderHistory) })
  })
)
```

Services that depend on the chat's user, like a `CurrentUser`, the handler
provides itself (see [chats and users](./chats)). The full rule is in
[what a handler may use](./assistant#what-a-handler-may-use).

## The chat a tool runs in

[`AssistantChat`](/api/AssistantChat) tells a tool which chat it's acting on,
and lets it read and add to the chat:

```ts
import { AssistantChat } from "effect-assistant"

const ExportInput = Schema.Struct({ month: Schema.String })

const startExport = Tool.make({
  name: "start_export",
  description: "Export this chat's orders to a spreadsheet.",
  inputSchema: ExportInput,
  run: Effect.fn(function* ({ month }: typeof ExportInput.Type) {
    const chat = yield* AssistantChat.AssistantChat
    const exports = yield* Exports // your service
    yield* exports.start({ chatId: chat.chatId, month })
    return { status: "started" }
  })
})
```

Tools also get the turn's other service, `Specialist.Runner`. The `AssistantEngine` isn't one of them. A tool whose
work reports back later starts a [workflow](./facts#long-running-work), and
the workflow notifies the chat.

## Tools that change things

A tool call is stored as started before it runs. If the process stops while
it runs, the next turn runs it again, with the same call id, before the model
goes on. So a call runs at least once, and a tool that orders, sends, or writes
something should do it once per call: `AssistantToolCall.idempotencyKey` is
the same every time the call runs.

**Example** (An order that a second run finds)

```ts
import * as Tool from "@effect-uai/core/Tool"
import { AssistantToolCall, RunId } from "effect-assistant"
import * as Effect from "effect/Effect"

const placeOrder = Tool.make({
  name: "place_order",
  description: "Places the order the user confirmed.",
  inputSchema: OrderInput,
  run: Effect.fn(function* (input: typeof OrderInput.Type) {
    // The same run id every time this call runs; the workflow's idempotency key is the run id.
    const runId = RunId.fromKey(yield* AssistantToolCall.idempotencyKey)
    yield* ProductOrder.execute({ runId, ...input }, { discard: true })

    return { runId }
  })
})
```

A side effect that can't take a key, like sending an email, goes in a
workflow step, which runs once per key however often the tool call does, or
behind the user's approval with a block. That's how durable-execution tools
handle it too: a step runs at least once, and the side effect is idempotent.

A call whose handler stopped while it ran (not a crash) gets a result saying
it may have run.

## Failures

Return `Tool.fail("…")` for failures the model should see and handle
("No office named Oslo"). The message becomes the tool's result. Anything
else that fails fails the turn, which is recorded as `TurnFailed`.

## Many tools: discovery

Every tool definition goes into the prompt on every call. For catalogs that
are big, or that change at runtime (MCP servers, plugins),
[`ToolDiscovery`](/api/ToolDiscovery) turns a toolkit into two tools:
`search_tools` finds tools by what the model needs to do, and `execute_tool`
runs one with a validated input.

```ts
import { ToolDiscovery } from "effect-assistant"

const toolkit = {
  ...Toolkit.make(listProducts, startCampaign), // common: always in the prompt
  ...ToolDiscovery.make(Toolkit.make(offices, shipmentEta)) // rare: found when needed
}
```

Keep the tools an assistant uses often in the toolkit directly; discovery
costs an extra step. For discovery over the tools a user may use, build it in
the handler, over [that user's tools](./chats#tools-per-user).
