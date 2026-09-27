/**
 * The `ToolFailure` module is the failure a tool gives the model: a message
 * it reads and adapts to, like "No office named Paris", instead of a turn that
 * fails.
 *
 * A tool declares it as its `failure` schema and fails with {@link fail}. The
 * loop gives the model any failure as the call's result: a tool's own failure
 * in its schema's JSON form, and params that don't fit the tool's schema as a
 * `ToolFailure` of kind `ToolParameterValidationError`. A step with a failed
 * call never ends the turn, so the model reads why. Only a defect fails the
 * turn.
 *
 * **Example** (A tool that tells the model what went wrong)
 *
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import * as Tool from "effect/unstable/ai/Tool"
 * import * as Toolkit from "effect/unstable/ai/Toolkit"
 * import { ToolFailure } from "effect-assistant"
 *
 * const OfficeBudget = Tool.make("office_budget", {
 *   description: "An office's budget this quarter.",
 *   parameters: Schema.Struct({ office: Schema.String }),
 *   success: Budget,
 *   failure: ToolFailure.ToolFailure
 * })
 *
 * const BudgetTools = Toolkit.make(OfficeBudget)
 *
 * const BudgetToolsLive = BudgetTools.toLayer({
 *   office_budget: ({ office }) =>
 *     Effect.fromNullishOr(budgets.get(office)).pipe(
 *       Effect.catch(() => ToolFailure.fail(`No office named ${office}.`, { kind: "not_found" }))
 *     )
 * })
 * ```
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
