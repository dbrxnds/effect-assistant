/**
 * The `InputId` module defines the id of one input to an assistant: a user message,
 * a block answer, or one of the app's events (in its `id` field).
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Uuid from "./internal/uuid.ts"

/** Schema for input ids: any string, branded. */
export const InputId = Schema.String.pipe(Schema.brand("effect-assistant/InputId"))

/** An input id. */
export type InputId = typeof InputId.Type

/** Creates a new random input id, with Effect's `Random`. */
export const make: Effect.Effect<InputId> = Effect.gen(function* () {
  const uuid = yield* Uuid.make

  return InputId.make(uuid)
})

/**
 * Creates the input id for a key, like `${runId}:order_placed`: the same key
 * gives the same id, so sending the input again stores it once.
 */
export const fromKey = (key: string): InputId => InputId.make(key)
