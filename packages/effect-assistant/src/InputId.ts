/**
 * The `InputId` module defines the id of one input to an assistant: a user message,
 * a block answer, or a fact.
 *
 * Input ids make submitting idempotent: an assistant stores an input once, so a
 * client or workflow can retry with the same id safely. Unlike chat and run
 * ids they have no fixed format. Derive them from what the input stands for
 * when that is stable (for example `${runId}:order_placed`), or let
 * {@link make} pick a random one. {@link fromKey} takes the key as the id.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Uuid from "./internal/uuid.ts"

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
 * Creates a new random input id, with Effect's `Random`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<InputId> = Effect.map(Uuid.random, (uuid) => InputId.make(uuid))

/**
 * Creates the input id for a key, like `${runId}:order_placed`: the same key
 * gives the same id, so sending the input again stores it once.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromKey = (key: string): InputId => InputId.make(key)
