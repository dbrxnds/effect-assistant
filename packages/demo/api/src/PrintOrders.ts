/**
 * Ordering branded products for an office.
 *
 * `quote_order` says what an order comes to (the product, units, total, and
 * the budget left after it). `place_order` places it, once the user approves
 * the call: it checks the budget again and starts the `PrintOrder` workflow. The workflow reports each stage as a `WorkflowStep` from
 * `workflow:PrintOrder`: `confirmed`, `printing`, `shipped` (with a tracking
 * number), and `delivered`. The assistant decides which ones the user hears
 * about.
 *
 * @since 0.1.0
 */
import { PlaceOrderParams } from "@acme/demo-shared/Approvals"
import * as Budgets from "@acme/demo-shared/Budgets"
import * as Locations from "@acme/demo-shared/Locations"
import * as Products from "@acme/demo-shared/Products"
import * as AssistantToolCall from "effect-assistant/AssistantToolCall"
import * as ChatId from "effect-assistant/ChatId"
import { CurrentChat } from "effect-assistant/CurrentChat"
import * as RunId from "effect-assistant/RunId"
import * as ToolFailure from "effect-assistant/ToolFailure"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Workflow from "effect/workflow/Workflow"
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine"
import * as LiveOrders from "./LiveOrders.ts"
import * as Steps from "./Steps.ts"

/**
 * The workflow that produces and ships a product order.
 *
 * @category workflows
 * @since 0.1.0
 */
export const PrintOrder = Workflow.make("PrintOrder", {
  payload: {
    runId: RunId.RunId,
    chatId: ChatId.ChatId,
    reference: Schema.String,
    office: Schema.String,
    productName: Schema.String,
    quantity: Schema.Int
  },
  success: Schema.Struct({ trackingNumber: Schema.String }),
  idempotencyKey: ({ runId }) => runId
})

type Payload = typeof PrintOrder.payloadSchema.Type

const step = (payload: Payload, status: string, details: Steps.Step["details"] = {}) =>
  Effect.gen(function* () {
    yield* Steps.report({
      workflow: "PrintOrder",
      runId: payload.runId,
      chatId: payload.chatId,
      status,
      details: { reference: payload.reference, product: payload.productName, quantity: payload.quantity, ...details }
    })
    const tracking = details.trackingNumber
    yield* LiveOrders.setStatus(payload.reference, status, Predicate.isString(tracking) ? tracking : undefined)
  })

/**
 * Layer that registers the workflow.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWorkflow = PrintOrder.toLayer(
  Effect.fn(function* (payload: Payload) {
    yield* step(payload, "confirmed", { office: payload.office })
    yield* Steps.wait("Proofing", 1)
    yield* step(payload, "printing")
    yield* Steps.wait("Printing", 2)

    const trackingNumber = `1Z${payload.reference.slice(4)}${payload.quantity}`
    yield* step(payload, "shipped", { carrier: "UPS", trackingNumber })
    yield* Steps.wait("InTransit", 3)
    yield* step(payload, "delivered", { office: payload.office })

    return { trackingNumber }
  })
)

/**
 * Lists the products offices can order.
 *
 * @category tools
 * @since 0.1.0
 */
export const ProductCatalog = Tool.make("product_catalog", {
  description:
    "Branded products offices can order (pens, notebooks, totes, banners, ...), with price, pack size, minimum, and lead time.",
  parameters: Schema.Struct({
    category: Schema.optional(Products.Category).annotate({ description: "Only this category." })
  }),
  success: Schema.Array(Products.Product)
})

/** What this deployment's orders add to an office's spend this quarter. */
const sessionSpend = Effect.fn(function* (location: Locations.Location) {
  const orders = yield* LiveOrders.LiveOrders
  const all = yield* orders.list

  return all
    .filter((order) => order.locationId === location.locationId && order.placedOn >= Budgets.currentQuarter.start)
    .reduce((sum, order) => sum + order.total, 0)
})

/**
 * Returns an office's budget this quarter, including orders placed through
 * Acme.
 *
 * @category getters
 * @since 0.1.0
 */
export const officeBudget = Effect.fn(function* (location: Locations.Location) {
  return Budgets.forOffice(location, yield* sessionSpend(location))
})

const OrderInput = Schema.Struct({
  office: Schema.String.annotate({ description: "Office name, like Amsterdam." }),
  product: Schema.String.annotate({ description: "Product name or SKU from product_catalog." }),
  quantity: Schema.Int.annotate({ description: "Units. Rounded up to whole packs and the minimum." })
})

/**
 * What an order comes to: what the user is told, and what the order checks
 * again when it runs. Fails for an unknown office or product, or an order
 * over the office's budget.
 *
 * @category getters
 * @since 0.1.0
 */
export const quote = Effect.fn(function* ({ office, product, quantity }: typeof OrderInput.Type) {
  const location = Locations.findByName(office)

  if (location === undefined) return yield* ToolFailure.fail(`No office named ${office}.`)

  const item = Products.search(product)

  if (item === undefined) return yield* ToolFailure.fail(`No product like "${product}". Check product_catalog.`)

  const units = Products.orderableQuantity(item, quantity)
  const total = Math.round(units * item.unitPrice * 100) / 100
  const budget = yield* officeBudget(location)

  if (total > budget.remaining) {
    return yield* ToolFailure.fail(
      `That's $${total}, and ${location.name} has $${budget.remaining} left in ${budget.quarter}. Ask about a smaller order or another office's budget.`,
      { reason: "OverBudget" }
    )
  }

  return {
    office: location.name,
    locationId: location.locationId,
    product: item.name,
    quantity: units,
    total,
    remainingBudget: Math.round((budget.remaining - total) * 100) / 100,
    leadTimeDays: item.leadTimeDays
  }
})

/**
 * Quotes a product order for an office: what the assistant shows the user
 * before they place it.
 *
 * @category tools
 * @since 0.1.0
 */
export const QuoteOrder = Tool.make("quote_order", {
  description:
    "What an order of branded products comes to for an office: units (rounded up to whole packs and the minimum), total, budget left after it, and lead time. Places nothing.",
  parameters: OrderInput,
  success: Schema.Struct({
    office: Schema.String,
    product: Schema.String,
    quantity: Schema.Int,
    total: Schema.Finite,
    remainingBudget: Schema.Finite,
    leadTimeDays: Schema.Int
  }),
  failure: ToolFailure.ToolFailure
})

/**
 * Places a product order, once the user approves the call.
 *
 * @category tools
 * @since 0.1.0
 */
export const PlaceOrder = Tool.make("place_order", {
  description:
    "Places a product order, with exactly what quote_order returned. The user approves it first: they see the order and approve or reject it, your turn ends meanwhile, and the outcome arrives later. Say in the same step what you're asking them to approve, in one line.",
  parameters: PlaceOrderParams,
  success: Schema.Struct({ reference: Schema.String }),
  failure: ToolFailure.ToolFailure,
  needsApproval: true,
  dependencies: [CurrentChat, AssistantToolCall.AssistantToolCall]
})

/**
 * The product ordering tools.
 *
 * @category toolkits
 * @since 0.1.0
 */
export const PrintTools = Toolkit.make(ProductCatalog, QuoteOrder, PlaceOrder)

/**
 * Layer for the product ordering tools' handlers, on the orders placed
 * through Acme.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerTools = PrintTools.toLayer(
  Effect.gen(function* () {
    const services = yield* Effect.context<LiveOrders.LiveOrders | WorkflowEngine.WorkflowEngine>()

    return PrintTools.of({
      product_catalog: ({ category }) =>
        Effect.succeed(Products.all.filter((product) => category === undefined || product.category === category)),
      quote_order: (order) =>
        quote(order).pipe(
          Effect.map(({ office, product, quantity, total, remainingBudget, leadTimeDays }) => ({
            office,
            product,
            quantity,
            total,
            remainingBudget,
            leadTimeDays
          })),
          Effect.provideContext(services)
        ),
      place_order: (order) => place(order).pipe(Effect.provideContext(services))
    })
  })
)

/**
 * Places the order the user approved: it checks the budget again and starts
 * the `PrintOrder` workflow. Once per call: the run's key is the call's, so a
 * call that runs again after a crash finds the first order.
 *
 * @category constructors
 * @since 0.1.0
 */
export const place = Effect.fn(function* (order: typeof PlaceOrderParams.Type) {
  const chatId = (yield* CurrentChat).chatId
  const runId = RunId.fromKey(yield* AssistantToolCall.idempotencyKey)
  const reference = Steps.reference(runId)
  const orders = yield* LiveOrders.LiveOrders

  if ((yield* orders.get(reference)) !== undefined) return { reference }

  // The budget may have moved since the quote the user approved; they agreed to that total, not another.
  const quoted = yield* quote(order)

  if (quoted.total !== order.total) {
    return yield* ToolFailure.fail(`That order now comes to $${quoted.total}, not $${order.total}. Quote it again.`)
  }

  yield* orders.put(
    LiveOrders.LiveOrder.make({
      reference,
      chatId,
      kind: "product",
      office: quoted.office,
      locationId: quoted.locationId,
      description: `${quoted.quantity} × ${quoted.product}`,
      total: quoted.total,
      status: "placed",
      placedOn: new Date().toISOString().slice(0, 10),
      updatedAt: Date.now()
    })
  )

  yield* PrintOrder.execute(
    { runId, chatId, reference, office: quoted.office, productName: quoted.product, quantity: quoted.quantity },
    { discard: true }
  )

  return { reference }
})
