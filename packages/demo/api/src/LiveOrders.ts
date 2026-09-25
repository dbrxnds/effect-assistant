/**
 * Orders placed through Acme, and where they are. Workflows update them as
 * they move (printing, shipped, live), so the order tools answer with the
 * current state.
 *
 * @since 0.1.0
 */
import * as ChatId from "effect-assistant/ChatId"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * An order placed in this deployment.
 *
 * @category models
 * @since 0.1.0
 */
export class LiveOrder extends Schema.Class<LiveOrder>("acme/LiveOrder")({
  /** What people quote, like `ACM-7K2Q9X`. */
  reference: Schema.String,
  /** The chat it was placed from. Deleting the chat deletes its orders. */
  chatId: Schema.optional(ChatId.ChatId),
  kind: Schema.Literals(["product", "campaign"]),
  office: Schema.String,
  locationId: Schema.String,
  description: Schema.String,
  /** In USD. */
  total: Schema.Finite,
  status: Schema.String,
  placedOn: Schema.String,
  updatedAt: Schema.Finite,
  trackingNumber: Schema.optional(Schema.String)
}) {}

/**
 * Service for the orders placed in this deployment.
 *
 * @category services
 * @since 0.1.0
 */
export class LiveOrders extends Context.Service<LiveOrders, {
  readonly put: (order: LiveOrder) => Effect.Effect<void>
  readonly get: (reference: string) => Effect.Effect<LiveOrder | undefined>
  /** Newest first. */
  readonly list: Effect.Effect<ReadonlyArray<LiveOrder>>
  /** Deletes the orders placed from a chat. */
  readonly removeChat: (chatId: ChatId.ChatId) => Effect.Effect<void>
}>()("acme/LiveOrders") {}

/**
 * Updates an order's status (and tracking number, when there is one).
 *
 * @category constructors
 * @since 0.1.0
 */
export const setStatus = Effect.fn(function*(reference: string, status: string, trackingNumber?: string) {
  const orders = yield* LiveOrders
  const order = yield* orders.get(reference)

  if (order === undefined) return

  yield* orders.put(
    LiveOrder.make({ ...order, status, updatedAt: Date.now(), trackingNumber: trackingNumber ?? order.trackingNumber })
  )
})

/**
 * Layer that keeps orders in memory.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory: Layer.Layer<LiveOrders> = Layer.effect(
  LiveOrders,
  Effect.gen(function*() {
    const orders = yield* Ref.make(new Map<string, LiveOrder>())

    return LiveOrders.of({
      put: (order) => Ref.update(orders, (all) => new Map(all).set(order.reference, order)),
      get: (reference) => Ref.get(orders).pipe(Effect.map((all) => all.get(reference.toUpperCase()))),
      list: Ref.get(orders).pipe(Effect.map((all) => [...all.values()].sort((a, b) => b.updatedAt - a.updatedAt))),
      removeChat: (chatId) =>
        Ref.update(orders, (all) => new Map([...all].filter(([, order]) => order.chatId !== chatId)))
    })
  })
)

const OrderJson = Schema.fromJsonString(LiveOrder)

/**
 * Layer that keeps orders in a SQL table, `demo_live_orders`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSql: Layer.Layer<LiveOrders, never, SqlClient.SqlClient> = Layer.effect(
  LiveOrders,
  Effect.gen(function*() {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()

    yield* sql`
      CREATE TABLE IF NOT EXISTS demo_live_orders (
        reference TEXT PRIMARY KEY,
        updated_at DOUBLE PRECISION NOT NULL,
        body TEXT NOT NULL
      )
    `.pipe(Effect.orDie)
    yield* sql`ALTER TABLE demo_live_orders ADD COLUMN IF NOT EXISTS chat_id TEXT`.pipe(Effect.orDie)
    // Orders from before they were tied to a chat can't be cleaned up with it; they were test runs.
    yield* sql`DELETE FROM demo_live_orders WHERE chat_id IS NULL`.pipe(Effect.orDie)

    const decode = Schema.decodeUnknownEffect(OrderJson)
    const encode = Schema.encodeEffect(OrderJson)

    return LiveOrders.of({
      put: Effect.fn(function*(order: LiveOrder) {
        const body = yield* encode(order)

        yield* sql`
          INSERT INTO demo_live_orders (reference, chat_id, updated_at, body)
          VALUES (${order.reference}, ${order.chatId ?? null}, ${order.updatedAt}, ${body})
          ON CONFLICT (reference) DO UPDATE SET updated_at = EXCLUDED.updated_at, body = EXCLUDED.body
        `
      }, Effect.orDie),
      get: Effect.fn(function*(reference: string) {
        const rows = yield* sql<{ readonly body: string }>`
          SELECT body FROM demo_live_orders WHERE reference = ${reference.toUpperCase()}
        `

        return rows[0] === undefined ? undefined : yield* decode(rows[0].body)
      }, Effect.orDie),
      list: sql<{ readonly body: string }>`SELECT body FROM demo_live_orders ORDER BY updated_at DESC`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.body))),
        Effect.orDie
      ),
      removeChat: (chatId) =>
        sql`DELETE FROM demo_live_orders WHERE chat_id = ${chatId}`.pipe(Effect.asVoid, Effect.orDie)
    })
  })
)
