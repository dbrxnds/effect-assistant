/**
 * The `AppEvent` module registers the app's own events with an assistant: a
 * workflow's progress, a webhook, a summary for compaction, the draft the
 * user opened. Each is a tagged schema, registered with two choices:
 * whether storing it wakes a turn, and how the model reads it (`render`).
 *
 * @since 0.1.0
 */
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"

/**
 * A schema for one of the app's own events: a tagged struct or class
 * (`Schema.TaggedStruct`, `Schema.TaggedClass`) that needs no services.
 *
 * @category models
 * @since 0.1.0
 */
export type EventSchema = Schema.Codec<{ readonly _tag: string }, { readonly _tag: string }> & {
  readonly fields: { readonly _tag: { readonly ast: SchemaAST.AST } }
}

/**
 * How the model reads an event: its tag and fields in JSON (`"json"`), or
 * the text a function of the event returns.
 *
 * @category models
 * @since 0.1.0
 */
export type Render<A> = "json" | ((event: A) => string)

/**
 * One of the app's events, registered: its schema and tag, whether it wakes a
 * turn, and how the model reads it (`undefined`: it doesn't).
 *
 * @category models
 * @since 0.1.0
 */
export interface AppEvent<S extends EventSchema = EventSchema> {
  readonly schema: S
  readonly tag: string
  readonly wakes: boolean
  readonly render: Render<S["Type"]> | undefined
}

/**
 * Any registered event, for generic constraints.
 *
 * @category utility types
 * @since 0.1.0
 */
export type Any = AppEvent<any>

/**
 * The type of a registered event's values.
 *
 * @category utility types
 * @since 0.1.0
 */
export type Type<E extends Any> = E["schema"]["Type"]

const tagOf = (schema: EventSchema): string => {
  const ast = schema.fields._tag.ast

  if (SchemaAST.isLiteral(ast) && Predicate.isString(ast.literal)) return ast.literal

  throw new Error("An app event is a tagged struct or class.")
}

/**
 * Registers one of the app's events: whether storing it wakes a turn
 * (default: no), and how the model reads it (default: as JSON when it
 * wakes a turn, not at all otherwise).
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <S extends EventSchema>(
  schema: S,
  options?: {
    /** Whether storing it starts a turn, like a user's message. Default false. */
    readonly wakes?: boolean | undefined
    /** How the model reads it in its history. */
    readonly render?: Render<S["Type"]> | undefined
  }
): AppEvent<S> => {
  const wakes = options?.wakes ?? false

  return {
    schema,
    tag: tagOf(schema),
    wakes,
    render: options?.render ?? (wakes ? "json" : undefined)
  }
}
