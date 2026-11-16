/**
 * This module provides status labels for tool calls: while a call runs, the chat shows the user a
 * short line about what the assistant is doing, like "Checking last summer's campaign budget".
 *
 * Mark the tools that take a while or act on something with {@link described}: workflows, reports
 * from other systems, orders, specialists. The model then sees an optional `description` parameter
 * on them and fills it in the chat's language. When the call starts, the chat sends the
 * description as a `ChatSignal.Status`; it shows until the next status, so it stays after the call
 * ends. The tool's handler never receives the parameter. Quick reads need no label: the chat shows its generic working state for
 * them.
 *
 * @since 0.13.0
 */
import type * as Tool from "effect/ai/Tool"
import * as Context from "effect/Context"
import type * as Schema from "effect/Schema"

type Schemas = {
  readonly parameters: Schema.Constraint
  readonly success: Schema.Constraint
  readonly failure: Schema.Constraint
  readonly failureMode: Tool.FailureMode
}

/**
 * The name of the parameter the model fills with a call's status.
 *
 * @category constants
 * @since 0.13.0
 */
export const parameterName = "description"

/**
 * What the model reads about the parameter.
 *
 * @category constants
 * @since 0.13.0
 */
export const parameterDescription =
  "Shown to the user while this runs: 3 to 8 plain words in the user's language about what you're doing, like \"Checking last summer's campaign budget\". No tool names, ids or code."

/**
 * Annotation for whether a tool's calls show a status, set with {@link described}.
 *
 * @category annotations
 * @since 0.13.0
 */
export const Described = Context.Reference<boolean>("effect-assistant/ToolStatus/Described", {
  defaultValue: () => false
})

/**
 * Marks a tool whose calls show a status while they run.
 *
 * **Details**
 *
 * The model sees an optional `description` parameter on the tool, and the chat shows what it
 * writes there while the call runs. The handler gets its parameters without it. A tool that has a
 * parameter of that name already can't be marked: the loop stops with a defect when it offers one.
 *
 * **Example** (A slow report with a status)
 *
 * ```ts
 * import { ToolStatus } from "effect-assistant"
 * import * as Tool from "effect/ai/Tool"
 * import * as Schema from "effect/Schema"
 *
 * export const CampaignReport = ToolStatus.described(
 *   Tool.make("campaign_report", {
 *     description: "The spend and results of a past campaign.",
 *     parameters: Schema.Struct({ campaignId: Schema.String }),
 *     success: Schema.Struct({ spent: Schema.Finite })
 *   })
 * )
 * ```
 *
 * @category annotations
 * @since 0.13.0
 */
export const described = <Name extends string, Config extends Schemas, R>(
  tool: Tool.Tool<Name, Config, R>
): Tool.Tool<Name, Config, R> => tool.annotate(Described, true)

/**
 * Returns whether a tool's calls show a status.
 *
 * @category guards
 * @since 0.13.0
 */
export const isDescribed = (tool: Tool.Any): boolean => Context.get(tool.annotations, Described)
