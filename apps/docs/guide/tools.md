# Tools

Tools are how the assistant looks things up and gets things done. They're
Effect's own tools (`effect/ai/Tool`), grouped in a toolkit
(`effect/ai/Toolkit`), with their handlers in a layer
(`MyToolkit.toLayer(...)`). The toolkit goes to `turn.loop` as `toolkit`,
next to the assistant's own tools; the handlers' layer is provided to the
assistant's.

Tool calls and their results are the assistant's own work: they're in the
chat's log, and the model reads them, but the user only sees what the
assistant tells them with `send_user_message`.

**Example** (A tool)

```ts
import { ToolFailure } from "effect-assistant"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"

const ListProducts = Tool.make("list_products", {
  description: "Products we sell, optionally in one category.",
  parameters: Schema.Struct({ category: Schema.optional(Schema.String) }),
  success: Schema.Array(Schema.Struct({ name: Schema.String, category: Schema.String })),
  failure: ToolFailure.ToolFailure
})

const ProductTools = Toolkit.make(ListProducts)

const ProductToolsLive = ProductTools.toLayer({
  list_products: ({ category }) => Effect.succeed([{ name: "Flyers", category: category ?? "print" }])
})

const MyAssistantHandlers = MyAssistant.toLayer((turn) => turn.loop({ instructions, toolkit: ProductTools })).pipe(
  Layer.provide(ProductToolsLive)
)
```

A tool is a name, a description the model reads, schemas for its parameters
and its result (`success`, `Schema.Void` if you leave it out), and a handler.
Names must be unique in a turn, including the assistant's own tools
(`send_user_message`, `wait`, `load_skill`, and the specialist tools): a
clash fails the turn.

The assistant's layer needs every tool's handler: leave out
`ProductToolsLive` and it's a type error naming the tool
(`Missing 'Handler<"list_products">'`). Several toolkits go together with
Effect's `Toolkit.merge(a, b)`, and their layers with `Layer.provide([...])`.

## Tools that use services

A handler gets its services one of two ways. Services the toolkit's layer
has, it yields in the layer's build; the layer requires them:

```ts
const OrderHistory = Tool.make("order_history", {
  description: "Recent orders, newest first. Optionally for one office.",
  parameters: Schema.Struct({ office: Schema.optional(Schema.String) }),
  success: Schema.Array(Order)
})

const OrderTools = Toolkit.make(OrderHistory)

const OrderToolsLive = OrderTools.toLayer(
  Effect.gen(function* () {
    const orders = yield* Orders // your service: the layer requires it

    return { order_history: ({ office }) => orders.recent(office) }
  })
)

const MyAssistantHandlers = MyAssistant.toLayer((turn) => turn.loop({ instructions, toolkit: OrderTools })).pipe(
  Layer.provide(OrderToolsLive)
)
```

Services a handler needs at call time, like the chat or the chat's user, are
its tool's `dependencies`. The loop then needs them: the turn provides
`AssistantChat` and `Specialist.Runner`, the loop `AssistantToolCall`, and the
handler provides the rest itself, like a `CurrentUser` (see
[chats and users](./chats)). The full rule is in
[what a handler may use](./assistant#what-a-handler-may-use).

## The chat a tool runs in

[`AssistantChat`](/api/AssistantChat) tells a tool which chat it's acting on,
and lets it read and add to the chat:

```ts
import { AssistantChat } from "effect-assistant"

const StartExport = Tool.make("start_export", {
  description: "Export this chat's orders to a spreadsheet.",
  parameters: Schema.Struct({ month: Schema.String }),
  success: Schema.Struct({ status: Schema.Literal("started") }),
  dependencies: [AssistantChat.AssistantChat]
})

const ExportTools = Toolkit.make(StartExport)

const ExportToolsLive = ExportTools.toLayer(
  Effect.gen(function* () {
    const exports = yield* Exports // your service

    return ExportTools.of({
      start_export: ({ month }) =>
        Effect.gen(function* () {
          const chat = yield* AssistantChat.AssistantChat
          yield* exports.start({ chatId: chat.chatId, month })

          return { status: "started" }
        })
    })
  })
)
```

Tools can also depend on the turn's other service, `Specialist.Runner`. The
`AssistantEngine` isn't one of them. A tool whose work reports back later
starts a [workflow](./app-events#long-running-work), and the workflow notifies
the chat.

## Tools that change things

A tool call is stored as started before it runs. If the process stops while
it runs, the next turn runs it again, with the same call id, before the model
goes on. So a call runs at least once, and a tool that orders, sends, or writes
something should do it once per call: `AssistantToolCall.idempotencyKey` is
the same every time the call runs.

**Example** (An order that a second run finds)

```ts
import { AssistantToolCall, RunId } from "effect-assistant"

const PlaceOrder = Tool.make("place_order", {
  description: "Places an order.",
  parameters: OrderInput,
  success: Schema.Struct({ runId: RunId.RunId }),
  dependencies: [AssistantToolCall.AssistantToolCall]
})

const placeOrder = (input: typeof OrderInput.Type) =>
  Effect.gen(function* () {
    // The same run id every time this call runs; the workflow's idempotency key is the run id.
    const runId = RunId.fromKey(yield* AssistantToolCall.idempotencyKey)
    yield* ProductOrder.execute({ runId, ...input }, { discard: true })

    return { runId }
  })
```

A side effect that can't take a key, like sending an email, goes in a
workflow step, which runs once per key however often the tool call does.
That's how durable-execution tools handle it too: a step runs at least once,
and the side effect is idempotent.

A tool whose effect the user must approve first sets `needsApproval`: the
call waits for the user's [decision](./decisions), and runs once they
approve.

A call whose handler stopped while it ran (not a crash) gets a failed result
saying it may have run (kind `may_have_run`); one that never started, that it
didn't run (`not_run`).

## Failures

A tool's failure is its result, which the model reads and adapts to: declare
`failure: ToolFailure.ToolFailure` and fail with `ToolFailure.fail("…")`
("No office named Oslo"), optionally with a `kind` the model (and you) can
tell apart:

```ts
office_budget: ({ office }) =>
  Effect.fromNullishOr(budgets.get(office)).pipe(
    Effect.catch(() => ToolFailure.fail(`No office named ${office}.`, { kind: "not_found" }))
  )
```

The log stores the call's `ToolResult` with its `outcome` (`"success"` or
`"failure"`), the `result` in JSON, and a failure's `kind`: a
`ToolFailure`'s kind, or the failure's tag. Params that don't fit the tool's
schema are a failure too, of kind `ToolParameterValidationError`, and so is
any failure a tool declares. A step with a failed call never ends the turn,
so the model reads why. Only a defect fails the turn, recorded as
`TurnFailed`.

A failure is stored in its JSON form. With `failureMode: "return"` on the
tool, the toolkit encodes it with the failure schema first.

## Strict tools

With models that support it, Anthropic's provider sends tools as strict, so
the model's params always fit their schema. A lot of tools, or big schemas,
can make Anthropic refuse the request ("The compiled grammar is too large").
Turn it off on the model, `AnthropicLanguageModel.model(name, { strictJsonSchema: false })`,
or per tool with `tool.annotate(Tool.Strict, false)`: params that don't fit are then
a failure the model reads and corrects.

## Many tools: a catalog

Every tool definition goes into the prompt on every call. For catalogs that
are big, or that change at runtime (MCP servers, plugins), pass them to the
loop as `catalog`: the model gets two tools instead, `search_tools`, which
finds tools by what it needs to do, and `execute_tool`, which runs one with a
validated input.

```ts
const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({
    instructions,
    toolkit: CommonTools, // common: always in the prompt
    catalog: OfficeTools // rare: found when needed
  })
).pipe(Layer.provide([CommonToolsLive, OfficeToolsLive]))
```

Keep the tools an assistant uses often in the toolkit directly; discovery
costs an extra step. `execute_tool` doesn't run a tool that needs the user's
[decision](./decisions): keep those in the toolkit directly too. For discovery over the tools a user may use, build it in
the handler, over [that user's tools](./chats#tools-per-user).
