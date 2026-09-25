/**
 * Ordering branded products for an office.
 *
 * `order_products` checks the office's budget and starts the `PrintOrder`
 * workflow, which reports each stage as a fact from `workflow:PrintOrder`:
 * `confirmed`, `printing`, `shipped` (with a tracking number), and
 * `delivered`. The assistant decides which ones the user hears about.
 *
 * @since 0.1.0
 */
import * as Budgets from "@acme/demo-shared/Budgets"
import * as Locations from "@acme/demo-shared/Locations"
import * as Products from "@acme/demo-shared/Products"
import * as Tool from "@effect-uai/core/Tool"
import * as AssistantToolCall from "effect-assistant/AssistantToolCall"
import * as AssistantTurn from "effect-assistant/AssistantTurn"
import * as ChatId from "effect-assistant/ChatId"
import * as RunId from "effect-assistant/RunId"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Workflow from "effect/unstable/workflow/Workflow"
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
  Effect.gen(function*() {
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
export const layerWorkflow = PrintOrder.toLayer(Effect.fn(function*(payload: Payload) {
  yield* step(payload, "confirmed", { office: payload.office })
  yield* Steps.wait("Proofing", 1)
  yield* step(payload, "printing")
  yield* Steps.wait("Printing", 2)

  const trackingNumber = `1Z${payload.reference.slice(4)}${payload.quantity}`
  yield* step(payload, "shipped", { carrier: "UPS", trackingNumber })
  yield* Steps.wait("InTransit", 3)
  yield* step(payload, "delivered", { office: payload.office })

  return { trackingNumber }
}))

const CatalogInput = Schema.Struct({
  category: Schema.optional(Products.Category).annotate({ description: "Only this category." })
})

/**
 * Lists the products offices can order.
 *
 * @category tools
 * @since 0.1.0
 */
export const productCatalog = Tool.make({
  name: "product_catalog",
  description:
    "Branded products offices can order (pens, notebooks, totes, banners, ...), with price, pack size, minimum, and lead time.",
  inputSchema: CatalogInput,
  run: ({ category }) =>
    Effect.succeed(Products.all.filter((product) => category === undefined || product.category === category))
})

/** What this deployment's orders add to an office's spend this quarter. */
const sessionSpend = Effect.fn(function*(location: Locations.Location) {
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
export const officeBudget = Effect.fn(function*(location: Locations.Location) {
  return Budgets.forOffice(location, yield* sessionSpend(location))
})

const OrderInput = Schema.Struct({
  office: Schema.String.annotate({ description: "Office name, like Amsterdam." }),
  product: Schema.String.annotate({ description: "Product name or SKU from product_catalog." }),
  quantity: Schema.Int.annotate({ description: "Units. Rounded up to whole packs and the minimum." })
})

/**
 * Orders products for an office, within its budget.
 *
 * @category tools
 * @since 0.1.0
 */
export const orderProducts = Tool.make({
  name: "order_products",
  description:
    "Order branded products for an office. Checks the office's budget, then starts production; progress arrives as facts from workflow:PrintOrder.",
  inputSchema: OrderInput,
  run: Effect.fn(function*({ office, product, quantity }: typeof OrderInput.Type) {
    // The same run for every time this call runs: after a crash it runs again, and finds its order.
    const runId = RunId.fromKey(yield* AssistantToolCall.idempotencyKey)
    const reference = Steps.reference(runId)
    const orders = yield* LiveOrders.LiveOrders
    const placed = yield* orders.get(reference)

    if (placed !== undefined) return { reference, status: placed.status, note: "Already placed by this call." }

    const location = Locations.findByName(office)

    if (location === undefined) return yield* Tool.fail(`No office named ${office}.`)

    const item = Products.search(product)

    if (item === undefined) return yield* Tool.fail(`No product like "${product}". Check product_catalog.`)

    const units = Products.orderableQuantity(item, quantity)
    const total = Math.round(units * item.unitPrice * 100) / 100
    const budget = yield* officeBudget(location)

    if (total > budget.remaining) {
      return yield* Tool.fail(
        `That's $${total}, and ${location.name} has $${budget.remaining} left in ${budget.quarter}. Ask about a smaller order or another office's budget.`
      )
    }

    const turn = yield* AssistantTurn.AssistantTurn

    yield* orders.put(
      LiveOrders.LiveOrder.make({
        reference,
        chatId: turn.chatId,
        kind: "product",
        office: location.name,
        locationId: location.locationId,
        description: `${units} × ${item.name}`,
        total,
        status: "placed",
        placedOn: new Date().toISOString().slice(0, 10),
        updatedAt: Date.now()
      })
    )
    yield* PrintOrder.execute(
      { runId, chatId: turn.chatId, reference, office: location.name, productName: item.name, quantity: units },
      { discard: true }
    )

    return {
      reference,
      product: item.name,
      quantity: units,
      total,
      remainingBudget: Math.round((budget.remaining - total) * 100) / 100,
      leadTimeDays: item.leadTimeDays,
      status: "placed"
    }
  })
})
