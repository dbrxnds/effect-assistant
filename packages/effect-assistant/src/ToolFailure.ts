/**
 * The `ToolFailure` module is the failure a tool gives the model: a message
 * it reads and adapts to, like "No office named Paris", instead of a turn that
 * fails.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * A tool's failure, written for the model: what went wrong, and optionally a
 * kind it can tell apart (`"not_found"`, `"over_budget"`).
 *
 * @category errors
 * @since 0.1.0
 */
export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", {
  message: Schema.String,
  kind: Schema.optional(Schema.String)
}) {}

/**
 * Fails a tool's handler with a message for the model.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fail = (
  message: string,
  options?: { readonly kind?: string | undefined }
): Effect.Effect<never, ToolFailure> =>
  Effect.fail(
    options?.kind === undefined ? ToolFailure.make({ message }) : ToolFailure.make({ message, kind: options.kind })
  )
