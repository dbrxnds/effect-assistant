/**
 * This module provides the id of a decision the user is asked to make, which is `decision:`
 * followed by a UUID.
 *
 * The model passes the id to a decision block, and the user's answer refers to it.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Uuid from "./internal/uuid.ts"

/**
 * Schema for decision ids of the form `` `decision:${uuid}` ``, branded.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DecisionId = Schema.TemplateLiteral(["decision:", Uuid.Uuid]).pipe(
  Schema.brand("~effect-assistant/DecisionId")
)

/**
 * Represents a decision id.
 *
 * @category models
 * @since 0.1.0
 */
export type DecisionId = typeof DecisionId.Type

/**
 * Creates the decision id for a key. The same key always gives the same id, so a decision that is
 * requested again is stored only once.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromKey = (key: string): DecisionId => DecisionId.make(`decision:${Uuid.fromKey(key)}`)

/**
 * Returns the decision id for a tool call that waits for the user's decision, derived from the
 * call's id.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromCallId = (callId: string): DecisionId => fromKey(`tool-call:${callId}`)
