/**
 * The `RunId` module defines the id of one background run, such as a
 * specialist run or a workflow started from a tool: `run:` followed by a
 * UUID.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Uuid from "./internal/uuid.ts"

/**
 * Schema for run ids: `` `run:${uuid}` ``, branded.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RunId = Schema.TemplateLiteral(["run:", Uuid.Uuid]).pipe(Schema.brand("effect-assistant/RunId"))

/**
 * A run id.
 *
 * @category models
 * @since 0.1.0
 */
export type RunId = typeof RunId.Type

/**
 * Creates a new random run id, with Effect's `Random`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<RunId> = Effect.map(Uuid.random, (uuid) => RunId.make(`run:${uuid}`))

/**
 * Creates the run id for a key, the same every time: for a run a tool call
 * starts, from its `AssistantToolCall.idempotencyKey`, so running the call
 * again finds the same run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromKey = (key: string): RunId => RunId.make(`run:${Uuid.fromKey(key)}`)
