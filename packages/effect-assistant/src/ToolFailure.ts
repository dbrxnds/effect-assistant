/**
 * Defines the failure a tool returns to the model.
 *
 * A {@link ToolFailure} carries a message the model reads and adapts to, such as "No office named
 * Paris", instead of failing the turn. Tools declare it as their `failure` schema and fail with
 * {@link fail}.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Represents a tool's failure, written for the model.
 *
 * It holds a message that says what went wrong and, optionally, a `kind` the model can tell apart,
 * such as `"not_found"` or `"over_budget"`.
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
 * **Details**
 *
 * The tool must declare `failure: ToolFailure.ToolFailure`. The model reads the failure as the
 * call's result, with its `kind` when one is given.
 *
 * **Example** (Failing a tool call the model can correct)
 *
 * ```ts
 * import { ToolFailure } from "effect-assistant"
 * import * as Tool from "effect/ai/Tool"
 * import * as Toolkit from "effect/ai/Toolkit"
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 *
 * const budgets = new Map([["Oslo", 1200]])
 *
 * const BudgetTools = Toolkit.make(
 *   Tool.make("office_budget", {
 *     description: "The budget left for an office.",
 *     parameters: Schema.Struct({ office: Schema.String }),
 *     success: Schema.Number,
 *     failure: ToolFailure.ToolFailure
 *   })
 * )
 *
 * const BudgetToolsLive = BudgetTools.toLayer({
 *   office_budget: ({ office }) =>
 *     Effect.fromNullishOr(budgets.get(office)).pipe(
 *       Effect.catch(() => ToolFailure.fail(`No office named ${office}.`, { kind: "not_found" }))
 *     )
 * })
 * ```
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
