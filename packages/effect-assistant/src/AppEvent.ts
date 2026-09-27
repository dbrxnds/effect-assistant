/**
 * The `AppEvent` module registers the app's own events with an assistant: a
 * workflow's progress, a webhook, a summary for compaction, the draft the
 * user opened. Each is a tagged schema, registered with two choices:
 *
 * - **`wakes`**: whether storing one starts a turn, like a user's message.
 *   Yes for what background work reports, so the assistant can tell the
 *   user; no for the app's bookkeeping.
 * - **`render`**: how the model reads it in its history: a function of the
 *   event that returns the text, or `"json"` for its tag and fields in JSON.
 *   An event that wakes a turn is read (as `"json"` unless it says how); one
 *   that doesn't, only when it says how, or when a history view puts it in.
 *
 * The user sees none of them: an assistant's messages are what reaches the
 * user, so a rendered event can say what it needs ("tell the user if it
 * matters") and let the assistant write the message.
 *
 * `Assistant.make(name, { events })` takes them. The assistant's `submit` and
 * `turn.append` take only registered events, and store each as itself, in
 * its schema's JSON form; `turn.entries`, history views, and `subscribe`
 * decode them to their types. One with an `id` field (an `InputId`) is
 * stored once per id, so a step that runs twice reports once.
 *
 * **Example** (A workflow's progress wakes a turn; the user's draft doesn't)
 *
 * ```ts
 * import * as Schema from "effect/Schema"
 * import { AppEvent, Assistant, InputId } from "effect-assistant"
 *
 * class OrderStep extends Schema.TaggedClass<OrderStep>()("OrderStep", {
 *   id: InputId.InputId,
 *   reference: Schema.String,
 *   status: Schema.String
 * }) {}
 *
 * class DraftOpened extends Schema.TaggedClass<DraftOpened>()("DraftOpened", { draftId: Schema.String }) {}
 *
 * export const MyAssistant = Assistant.make("my-assistant", {
 *   events: [
 *     AppEvent.make(OrderStep, {
 *       wakes: true,
 *       render: (step) =>
 *         `<order reference="${step.reference}">It's ${step.status} now. The user hasn't seen this: tell them if it matters.</order>`
 *     }),
 *     AppEvent.make(DraftOpened, { render: (opened) => `The user opened draft ${opened.draftId}.` })
 *   ]
 * })
 *
 * // In a workflow's activity: the id makes a replay harmless.
 * MyAssistant.submit(chatId, OrderStep.make({ id: InputId.fromKey(`${runId}:shipped`), reference, status: "shipped" }))
 * ```
 *
 * **Evolving an event's schema**
 *
 * A log is kept for good, and an app event's schema decodes every one
 * stored with it. The library's events are versioned (see
 * `AssistantEvent`); an app's evolve the same way, in its own schema:
 *
 * - A field added later is optional, or has a decoding default
 *   (`Schema.optionalKey(...)`, `Schema.withDecodingDefaultKey(...)`), so
 *   the events stored before it still decode.
 * - A change that old events can't be decoded into is a new tag
 *   (`OrderStepV2`); keep the old one registered, with its `render`, so the
 *   chats that have it read as they did.
 * - An event that doesn't decode, like one whose tag is no longer
 *   registered, is left out: the model doesn't read it, `turn.entries` and
 *   `subscribe` skip it, and it wakes nothing.
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

/** The literal `_tag` of a tagged struct or class. */
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

  return { schema, tag: tagOf(schema), wakes, render: options?.render ?? (wakes ? "json" : undefined) }
}
