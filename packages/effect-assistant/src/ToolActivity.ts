/**
 * This module provides status labels for tool calls: while a call runs, the chat shows the user a
 * short line about what the assistant is doing, like "Checking last summer's campaign budget".
 *
 * Give the tools that take a while or act on something a status field with {@link withActivity}:
 * workflows, reports from other systems, orders, specialists. Their parameters get an optional
 * `activity` field that the model fills in the chat's language. When the call starts, the chat
 * sends the activity as a `ChatSignal.Activity`; it shows until the next status, so it stays
 * while the model works out its next step. The call runs unchanged: the handler gets `activity`
 * with its other parameters. Quick reads need no label: the chat shows its generic
 * working state for them.
 *
 * @since 0.13.0
 */
import type * as Tool from "effect/ai/Tool"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"

/**
 * The name of the parameter the model fills with a call's status.
 *
 * @category constants
 * @since 0.13.0
 */
export const parameterName = "activity"

/**
 * What the model reads about the parameter.
 *
 * @category constants
 * @since 0.13.0
 */
export const parameterDescription =
  "What you're doing with this call, in a few plain words the user sees while it runs. Write it from their side, with no tool names, and don't repeat something they've already seen this turn. Leave it out if there's nothing worth showing."

const statusFieldKey = "effect-assistant/ToolActivity/statusField"

/**
 * The schema of the status field {@link withActivity} adds.
 *
 * @category schemas
 * @since 0.16.0
 */
export const ActivityField = Schema.String.annotate({ description: parameterDescription, [statusFieldKey]: true }).pipe(
  Schema.optionalKey
)

/**
 * The parameter fields a struct can't have to take a status field: an `activity` field of its own.
 *
 * @category models
 * @since 0.16.0
 */
export type WithoutActivity<Fields extends Schema.Struct.Fields> = typeof parameterName extends keyof Fields
  ? "Error: these parameters have an activity field already, so they can't take a status: rename it"
  : unknown

/**
 * Adds the status field to a tool's parameters, so its calls show a status while they run.
 *
 * **Details**
 *
 * The struct gets an optional `activity` field ({@link ActivityField}), and keeps its own annotations
 * and checks. The chat shows what the model writes there while the call runs; a call without one,
 * or with a blank one, runs with no status. The handler gets `activity` like any other parameter.
 * A struct that has an `activity` field already is a type error. A tool without parameters takes
 * `Schema.Struct({})`.
 *
 * **Example** (A tool whose calls show a status)
 *
 * ```ts
 * import { ToolActivity } from "effect-assistant"
 * import * as Tool from "effect/ai/Tool"
 * import * as Schema from "effect/Schema"
 *
 * export const ArchiveNote = Tool.make("archive_note", {
 *   description: "Archives a note and the files attached to it.",
 *   parameters: Schema.Struct({ noteId: Schema.String }).pipe(ToolActivity.withActivity),
 *   success: Schema.Struct({ archived: Schema.Boolean })
 * })
 * ```
 *
 * @category combinators
 * @since 0.16.0
 */
export const withActivity = <Fields extends Schema.Struct.Fields>(
  self: Schema.Struct<Fields> & WithoutActivity<Fields>
) => {
  const struct = self.mapFields((fields) => ({ ...fields, [parameterName]: ActivityField }))

  return struct.rebuild(
    new SchemaAST.Objects(
      struct.ast.propertySignatures,
      struct.ast.indexSignatures,
      self.ast.annotations,
      self.ast.checks
    )
  )
}

/**
 * Returns whether a tool's calls show a status: its parameters have the field {@link withActivity}
 * adds. An `activity` parameter of its own doesn't count.
 *
 * @category guards
 * @since 0.13.0
 */
export const hasActivity = (tool: Tool.Any): boolean => {
  const ast = tool.parametersSchema.ast

  return (
    SchemaAST.isObjects(ast) &&
    ast.propertySignatures.some(
      (property) =>
        property.name === parameterName && SchemaAST.resolveAt<boolean>(statusFieldKey)(property.type) === true
    )
  )
}
