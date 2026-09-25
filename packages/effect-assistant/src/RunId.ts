/**
 * The `RunId` module defines the id of one background run, such as a
 * specialist run or a workflow started from a tool: `run:` followed by a
 * nanoid.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Nanoid from "./internal/nanoid.ts"

/**
 * Schema for run ids: `` `run:${nanoid}` ``, branded.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RunId = Schema.TemplateLiteral(["run:", Nanoid.Nanoid]).pipe(Schema.brand("effect-assistant/RunId"))

/**
 * A run id.
 *
 * @category models
 * @since 0.1.0
 */
export type RunId = typeof RunId.Type

/**
 * Creates a new random run id.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (): RunId => Schema.decodeSync(RunId)(`run:${Nanoid.make()}`)

/**
 * Creates the run id for a key, the same every time: for a run a tool call
 * starts, from its `AssistantToolCall.idempotencyKey`, so running the call
 * again finds the same run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromKey = (key: string): RunId => Schema.decodeSync(RunId)(`run:${Nanoid.fromKey(key)}`)
