/**
 * The `DecisionId` module defines the id of one decision the user is asked
 * to make: `decision:` followed by a UUID. The model passes it to a decision
 * block, and the user's answer names it.
 *
 * A decision's id comes from what it's about, so asking again finds the same
 * decision: a parked tool call's from its call id, and one that work
 * requests from its key.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Uuid from "./internal/uuid.ts"

/**
 * Schema for decision ids: `` `decision:${uuid}` ``, branded.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DecisionId = Schema.TemplateLiteral(["decision:", Uuid.Uuid]).pipe(
  Schema.brand("effect-assistant/DecisionId")
)

/**
 * A decision id.
 *
 * @category models
 * @since 0.1.0
 */
export type DecisionId = typeof DecisionId.Type

/**
 * Creates the decision id for a key: the same key gives the same id, so
 * requesting the decision again stores it once.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromKey = (key: string): DecisionId => DecisionId.make(`decision:${Uuid.fromKey(key)}`)

/**
 * The decision id of a tool call that waits for the user's decision.
 *
 * @category constructors
 * @since 0.1.0
 */
export const forCall = (callId: string): DecisionId => fromKey(`tool-call:${callId}`)
