/**
 * This module provides status labels for tool calls: while a call runs, the chat shows the user a
 * short line about what the assistant is doing, like "Checking last summer's campaign budget".
 *
 * Give the tools that take a while or act on something a status field with {@link withStatus}:
 * workflows, reports from other systems, orders, specialists. Their parameters get a required
 * `description` field that the model fills in the chat's language. When the call starts, the chat
 * sends the description as a `ChatSignal.Status`; it shows until the next status, so it stays
 * after the call ends. The call runs unchanged: the handler gets `description` with its other
 * parameters. Quick reads need no label: the chat shows its generic working state for them.
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
export const parameterName = "description"

/**
 * What the model reads about the parameter.
 *
 * @category constants
 * @since 0.13.0
 */
export const parameterDescription =
  "Shown to the user while this runs: 3 to 8 plain words in the user's language about what you're doing, like \"Checking last summer's campaign budget\". No tool names, ids or code."

const statusFieldKey = "effect-assistant/ToolStatus/statusField"

/**
 * The schema of the status field {@link withStatus} adds.
 *
 * @category schemas
 * @since 0.16.0
 */
export const StatusField = Schema.String.annotate({ description: parameterDescription, [statusFieldKey]: true })

/**
 * The parameter fields a struct can't have to take a status field: a `description` field of its own.
 *
 * @category models
 * @since 0.16.0
 */
export type WithoutStatus<Fields extends Schema.Struct.Fields> = typeof parameterName extends keyof Fields
  ? "Error: these parameters have a description field already, so they can't take a status: rename it"
  : unknown

/**
 * Adds the status field to a tool's parameters, so its calls show a status while they run.
 *
 * **Details**
 *
 * The struct gets a required `description` field ({@link StatusField}), and keeps its own
 * annotations and checks. Required, because models leave optional parameters out. The chat shows
 * what the model writes there while the call runs; a call with a blank one runs with no status,
 * and a call without it fails validation like a call without any other required parameter. The
 * handler gets `description` like any other parameter. A struct that has a `description` field
 * already is a type error. A tool without parameters takes `Schema.Struct({})`.
 *
 * **Example** (A tool whose calls show a status)
 *
 * ```ts
 * import { ToolStatus } from "effect-assistant"
 * import * as Tool from "effect/ai/Tool"
 * import * as Schema from "effect/Schema"
 *
 * export const ArchiveNote = Tool.make("archive_note", {
 *   description: "Archives a note and the files attached to it.",
 *   parameters: Schema.Struct({ noteId: Schema.String }).pipe(ToolStatus.withStatus),
 *   success: Schema.Struct({ archived: Schema.Boolean })
 * })
 * ```
 *
 * @category combinators
 * @since 0.16.0
 */
export const withStatus = <Fields extends Schema.Struct.Fields>(
  self: Schema.Struct<Fields> & WithoutStatus<Fields>
) => {
  const struct = self.mapFields((fields) => ({ ...fields, [parameterName]: StatusField }))

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
 * Returns whether a tool's calls show a status: its parameters have the field {@link withStatus}
 * adds. A `description` parameter of its own doesn't count.
 *
 * @category guards
 * @since 0.13.0
 */
export const isDescribed = (tool: Tool.Any): boolean => {
  const ast = tool.parametersSchema.ast

  return (
    SchemaAST.isObjects(ast) &&
    ast.propertySignatures.some(
      (property) =>
        property.name === parameterName && SchemaAST.resolveAt<boolean>(statusFieldKey)(property.type) === true
    )
  )
}
