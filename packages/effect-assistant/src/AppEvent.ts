/**
 * Registers an application's own events with an assistant.
 *
 * An app event is a tagged schema for something the application reports into a chat, such as a
 * workflow's progress, a webhook, a summary for compaction, or the draft the user opened.
 * {@link make} registers one with two choices: whether storing it wakes a turn (`wakes`), and
 * how the model reads it (`render`).
 *
 * @since 0.1.0
 */
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"

/**
 * Schema for one of the application's own events.
 *
 * It is a tagged struct or class (`Schema.TaggedStruct`, `Schema.TaggedClass`) that needs no
 * services.
 *
 * @category models
 * @since 0.1.0
 */
export type EventSchema = Schema.Codec<{ readonly _tag: string }, { readonly _tag: string }> & {
  readonly fields: { readonly _tag: { readonly ast: SchemaAST.AST } }
}

/**
 * Describes how the model reads an event.
 *
 * `"json"` shows the event's tag and fields as JSON. A function shows the text it returns for the
 * event.
 *
 * @category models
 * @since 0.1.0
 */
export type Render<A> = "json" | ((event: A) => string)

/**
 * Represents one of the application's events, registered with an assistant.
 *
 * It holds the event's schema and tag, whether storing it wakes a turn, and how the model reads
 * it. A `render` of `undefined` means the model doesn't read it.
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
 * Represents any registered event, for generic constraints.
 *
 * @category utility types
 * @since 0.1.0
 */
export type Any = AppEvent<any>

/**
 * Extracts the type of a registered event's values.
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
 * Registers one of the application's events with an assistant.
 *
 * **Details**
 *
 * Storing the event wakes a turn only when `wakes` is `true`; it defaults to `false`. `render`
 * defaults to `"json"` for an event that wakes a turn. An event that doesn't wake a turn and has
 * no `render` isn't read by the model.
 *
 * The schema must be a tagged struct or class whose `_tag` is a string literal; `make` throws
 * otherwise.
 *
 * **Example** (Registering an event that wakes a turn)
 *
 * ```ts
 * import { AppEvent, Assistant, InputId } from "effect-assistant"
 * import * as Schema from "effect/Schema"
 *
 * class OrderShipped extends Schema.TaggedClass<OrderShipped>()("OrderShipped", {
 *   id: InputId.InputId,
 *   orderId: Schema.String,
 *   carrier: Schema.String
 * }) {}
 *
 * export const MyAssistant = Assistant.make("my-assistant", {
 *   events: [
 *     AppEvent.make(OrderShipped, {
 *       wakes: true,
 *       render: (shipped) =>
 *         `Order ${shipped.orderId} shipped with ${shipped.carrier}. Tell the user if it matters.`
 *     })
 *   ]
 * })
 * ```
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
