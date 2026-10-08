/**
 * The `DecisionId` module defines the id of one decision the user is asked
 * to make: `decision:` followed by a UUID. The model passes it to a decision
 * block, and the user's answer names it.
 */
import * as Schema from "effect/Schema"
import * as Uuid from "./internal/uuid.ts"

/** Schema for decision ids: `` `decision:${uuid}` ``, branded. */
export const DecisionId = Schema.TemplateLiteral(["decision:", Uuid.Uuid]).pipe(
  Schema.brand("effect-assistant/DecisionId")
)

/** A decision id. */
export type DecisionId = typeof DecisionId.Type

/**
 * Creates the decision id for a key: the same key gives the same id, so
 * requesting the decision again stores it once.
 */
export const fromKey = (key: string): DecisionId => DecisionId.make(`decision:${Uuid.fromKey(key)}`)

/** The decision id of a tool call that waits for the user's decision. */
export const fromCallId = (callId: string): DecisionId => fromKey(`tool-call:${callId}`)
