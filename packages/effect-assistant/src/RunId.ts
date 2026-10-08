/**
 * This module provides the id of a background run, such as a specialist run or a workflow started
 * from a tool. A run id is `run:` followed by a UUID.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Uuid from "./internal/uuid.ts"

/**
 * Schema for run ids of the form `` `run:${uuid}` ``, branded.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RunId = Schema.TemplateLiteral(["run:", Uuid.Uuid]).pipe(Schema.brand("~effect-assistant/RunId"))

/**
 * Represents a run id.
 *
 * @category models
 * @since 0.1.0
 */
export type RunId = typeof RunId.Type

/**
 * Creates a new random run id using Effect's `Random`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (): Effect.Effect<RunId> => Effect.map(Uuid.make, (uuid) => RunId.make(`run:${uuid}`))

/**
 * Creates the run id for a key. The same key always gives the same id.
 *
 * **When to use**
 *
 * Use it for a run that a tool call starts, with the call's `AssistantToolCall.idempotencyKey` as
 * the key, so running the call again finds the same run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromKey = (key: string): RunId => RunId.make(`run:${Uuid.fromKey(key)}`)
