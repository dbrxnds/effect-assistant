/**
 * What the API tells the chat when the user places an order or starts a
 * campaign from its block: one of Acme's own events. It wakes a turn, so Acme
 * follows up with the reference.
 *
 * @since 0.1.0
 */
import * as AppEvent from "effect-assistant/AppEvent"
import * as InputId from "effect-assistant/InputId"
import * as Schema from "effect/Schema"

/**
 * An order or campaign the user placed from a block.
 *
 * @category models
 * @since 0.1.0
 */
export class OrderPlaced extends Schema.TaggedClass<OrderPlaced>()("OrderPlaced", {
  /** Per order, so a second click tells the chat once. */
  id: InputId.InputId,
  kind: Schema.Literals(["product", "campaign"]),
  /** The block the user placed it from. */
  messageId: Schema.String,
  reference: Schema.String,
  office: Schema.String,
  description: Schema.String,
  total: Schema.Finite
}) {}

/**
 * How the model reads it.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (placed: OrderPlaced): string =>
  `<order_placed kind="${placed.kind}" message="${placed.messageId}" reference="${placed.reference}">\nThe user placed it with the button on your message ${placed.messageId}: ${placed.description} for ${placed.office}, $${placed.total}.\n</order_placed>`

/**
 * The event, registered with Acme: it wakes a turn.
 *
 * @category events
 * @since 0.1.0
 */
export const event = AppEvent.make(OrderPlaced, { wakes: true, render })
