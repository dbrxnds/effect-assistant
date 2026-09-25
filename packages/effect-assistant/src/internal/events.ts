/**
 * An assistant's own events and inputs: which tags are inputs, and how they
 * go to and from the form they're stored in (`AssistantEvent.AppEvent`).
 *
 * @since 0.1.0
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import type * as Assistant from "../Assistant.ts"
import * as AssistantEvent from "../AssistantEvent.ts"

/**
 * An assistant's own events, by tag, and which of them are inputs.
 *
 * @internal
 */
export interface AppEvents {
  readonly byTag: ReadonlyMap<string, Assistant.EventSchema>
  /** The tags of the app's inputs: they wake a turn, and the model reads them. */
  readonly inputs: ReadonlySet<string>
}

/** The literal `_tag` of a tagged struct or class. */
const tagOf = (schema: Assistant.EventSchema): string => {
  const ast = schema.fields._tag.ast

  if (SchemaAST.isLiteral(ast) && Predicate.isString(ast.literal)) return ast.literal

  throw new Error("An assistant's events and inputs are tagged structs or classes.")
}

/**
 * Collects an assistant's events and inputs. A tag used twice, or one of the
 * library's, is a mistake in the definition.
 *
 * @internal
 */
export const make = (
  events: ReadonlyArray<Assistant.EventSchema>,
  inputs: ReadonlyArray<Assistant.EventSchema>
): AppEvents => {
  const all = [...events, ...inputs]
  const byTag = new Map(all.map((schema) => [tagOf(schema), schema]))

  for (const tag of byTag.keys()) {
    if (AssistantEvent.isLibraryEvent({ _tag: tag })) throw new Error(`${tag} is one of the library's events.`)
  }

  if (byTag.size !== all.length) throw new Error("An assistant's events and inputs have different tags.")

  return { byTag, inputs: new Set(inputs.map(tagOf)) }
}

/**
 * Encodes one of the app's events to the form it's stored in: its schema's
 * JSON form. An event with no schema here is a mistake in the handler.
 *
 * @internal
 */
export const encode = (app: AppEvents, event: { readonly _tag: string }): Effect.Effect<AssistantEvent.AppEvent> => {
  const schema = app.byTag.get(event._tag)

  if (schema === undefined) return Effect.die(`${event._tag} isn't one of this assistant's events or inputs.`)

  return Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(event).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AssistantEvent.AppEvent)),
    Effect.orDie
  )
}

/**
 * Decodes a stored entry's app event with the assistant's schemas. The
 * library's events pass through. An app event that doesn't decode (say, one
 * from an older version of its schema) is left out.
 *
 * @internal
 */
export const decodeEntry = (app: AppEvents, entry: AssistantEvent.AnyEntry): Option.Option<Assistant.Entry<any>> => {
  const { event } = entry

  if (AssistantEvent.isLibraryEvent(event)) return Option.some({ ...toEntry(entry), event })

  const schema = app.byTag.get(event._tag)

  if (schema === undefined) return Option.none()

  return Option.map(Schema.decodeUnknownOption(Schema.toCodecJson(schema))(event), (decoded) => ({
    ...toEntry(entry),
    event: decoded
  }))
}

const toEntry = (entry: AssistantEvent.AnyEntry) => ({ chatId: entry.chatId, seq: entry.seq, at: entry.at })
