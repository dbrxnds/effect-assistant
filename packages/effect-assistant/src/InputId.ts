/**
 * This module provides the id of an input to an assistant. An input is a user message, a block
 * answer, or one of the app's events, and the id is stored in its `id` field.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Uuid from "./internal/uuid.ts"

/**
 * Schema for input ids. Any string is a valid input id, and the schema brands it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const InputId = Schema.String.pipe(Schema.brand("effect-assistant/InputId"))

/**
 * Represents an input id.
 *
 * @category models
 * @since 0.1.0
 */
export type InputId = typeof InputId.Type

/**
 * Creates a new random input id using Effect's `Random`. Seed `Random` in tests to get the same ids
 * on every run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (): Effect.Effect<InputId> => Effect.map(Uuid.make, (uuid) => InputId.make(uuid))

/**
 * Creates the input id for a key, such as `${runId}:order_placed`. The same key always gives the
 * same id, so an input that is sent again is stored only once.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromKey = (key: string): InputId => InputId.make(key)
