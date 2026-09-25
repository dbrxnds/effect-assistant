/**
 * The `InputId` module defines the id of one input to an assistant: a user message,
 * a block answer, or a fact.
 *
 * Input ids make submitting idempotent: an assistant stores an input once, so a
 * client or workflow can retry with the same id safely. Unlike chat and run
 * ids they have no fixed format. Derive them from what the input stands for
 * when that is stable (for example `${runId}:order_placed`), or let
 * {@link make} pick a random one.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Nanoid from "./internal/nanoid.ts"

/**
 * Schema for input ids: any string, branded.
 *
 * @category schemas
 * @since 0.1.0
 */
export const InputId = Schema.String.pipe(Schema.brand("effect-assistant/InputId"))

/**
 * An input id.
 *
 * @category models
 * @since 0.1.0
 */
export type InputId = typeof InputId.Type

/**
 * Creates an input id: this one, like `${runId}:order_placed` for an input
 * that may be sent again, or a new random one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (value?: string): InputId => InputId.make(value ?? Nanoid.make())
