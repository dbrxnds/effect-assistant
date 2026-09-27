/**
 * Ordering branded products for an office.
 *
 * `order_products` needs the user's decision: when the model calls it, the
 * call waits, and the user sees its quote (the product, units, total, and
 * the budget left after it). Their yes runs it: it checks the budget again
 * and starts the `PrintOrder` workflow, which reports each stage as a fact
 * from `workflow:PrintOrder`: `confirmed`, `printing`, `shipped` (with a
 * tracking number), and `delivered`. The assistant decides which ones the
 * user hears about.
 *
 * @since 0.1.0
 */
import * as Budgets from "@acme/demo-shared/Budgets"
import * as Locations from "@acme/demo-shared/Locations"
import * as Products from "@acme/demo-shared/Products"
import * as AssistantToolCall from "effect-assistant/AssistantToolCall"
import * as AssistantChat from "effect-assistant/AssistantChat"
import * as ChatId from "effect-assistant/ChatId"
import * as RunId from "effect-assistant/RunId"
import * as ToolFailure from "effect-assistant/ToolFailure"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as Workflow from "effect/unstable/workflow/Workflow"
import type * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
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
      source: "workflow:PrintOrder",
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

const OrderPlaced = Schema.Struct({
  reference: Schema.String,
  product: Schema.String,
  quantity: Schema.Int,
  total: Schema.Finite,
  remainingBudget: Schema.Finite,
  leadTimeDays: Schema.Int,
  status: Schema.Literal("placed")
})

const OrderInput = Schema.Struct({
  office: Schema.String.annotate({ description: "Office name, like Amsterdam." }),
  product: Schema.String.annotate({ description: "Product name or SKU from product_catalog." }),
  quantity: Schema.Int.annotate({ description: "Units. Rounded up to whole packs and the minimum." })
})

/**
 * What an order comes to: what the user approves, and what the order checks
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
      { kind: "over_budget" }
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
 * Orders products for an office, within its budget, once the user approves.
 *
 * @category tools
 * @since 0.1.0
 */
export const OrderProducts = Tool.make("order_products", {
  description:
    "Order branded products for an office. It waits for the user's decision, with the total and the budget left; once they approve, production starts and progress arrives as facts from workflow:PrintOrder.",
  parameters: OrderInput,
  success: Schema.Union([
    Schema.Struct({ reference: Schema.String, status: Schema.String, note: Schema.String }),
    OrderPlaced
  ]),
  failure: ToolFailure.ToolFailure,
  dependencies: [AssistantChat.AssistantChat, AssistantToolCall.AssistantToolCall],
  needsApproval: true
})

/**
 * The product ordering tools.
 *
 * @category toolkits
 * @since 0.1.0
 */
export const PrintTools = Toolkit.make(ProductCatalog, OrderProducts)

/**
 * Layer for the product ordering tools' handlers, on the orders placed
 * through Acme and the workflow engine.
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
      order_products: (order) =>
        Effect.gen(function* () {
          // The same run for every time this call runs: after a crash it runs again, and finds its order.
          const runId = RunId.fromKey(yield* AssistantToolCall.idempotencyKey)
          const reference = Steps.reference(runId)
          const orders = yield* LiveOrders.LiveOrders
          const placed = yield* orders.get(reference)

          if (placed !== undefined) return { reference, status: placed.status, note: "Already placed by this call." }

          // The budget may have moved since the user approved the quote.
          const quoted = yield* quote(order)
          const chat = yield* AssistantChat.AssistantChat

          yield* orders.put(
            LiveOrders.LiveOrder.make({
              reference,
              chatId: chat.chatId,
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
            {
              runId,
              chatId: chat.chatId,
              reference,
              office: quoted.office,
              productName: quoted.product,
              quantity: quoted.quantity
            },
            { discard: true }
          )

          const placedNow: typeof OrderPlaced.Type = {
            reference,
            product: quoted.product,
            quantity: quoted.quantity,
            total: quoted.total,
            remainingBudget: quoted.remainingBudget,
            leadTimeDays: quoted.leadTimeDays,
            status: "placed"
          }

          return placedNow
        }).pipe(Effect.provideContext(services))
    })
  })
)

/**
 * What the user sees before they approve a product order: its quote, on the
 * orders placed through Acme.
 *
 * @category layers
 * @since 0.1.0
 */
export const previews = Effect.gen(function* () {
  const orders = yield* LiveOrders.LiveOrders

  return {
    order_products: ({ office, product, quantity }: typeof OrderInput.Type) =>
      quote({ office, product, quantity }).pipe(
        Effect.map((quoted) => ({
          office: quoted.office,
          product: quoted.product,
          quantity: quoted.quantity,
          total: quoted.total,
          remainingBudget: quoted.remainingBudget,
          leadTimeDays: quoted.leadTimeDays
        })),
        Effect.provideService(LiveOrders.LiveOrders, orders)
      )
  }
})
