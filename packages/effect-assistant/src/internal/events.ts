import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Record from "effect/Record"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import type * as Assistant from "../Assistant.ts"
import * as AssistantEvent from "../AssistantEvent.ts"
import { inputKey } from "./input.ts"
import { toJson as anyToJson } from "./schema.ts"

/** @internal */
export interface AppEvents {
  readonly byTag: ReadonlyMap<string, AssistantEvent.AppEventSchema>
}

/** @internal */
export const tagOf = (schema: AssistantEvent.AppEventSchema): string => {
  const ast = schema.fields._tag.ast

  if (SchemaAST.isLiteral(ast) && Predicate.isString(ast.literal)) return ast.literal

  throw new Error("An app event is a tagged struct or class.")
}

/** @internal */
export const make = (events: ReadonlyArray<AssistantEvent.AppEventSchema>): AppEvents => {
  const byTag = new Map(events.map((schema): [string, AssistantEvent.AppEventSchema] => [tagOf(schema), schema]))

  for (const tag of byTag.keys()) {
    if (AssistantEvent.isLibraryEvent({ _tag: tag })) throw new Error(`${tag} is one of the library's events.`)
  }

  if (byTag.size !== events.length) throw new Error("An assistant's events have different tags.")

  return { byTag }
}

/** @internal */
export const encode = Effect.fnUntraced(function* (app: AppEvents, event: { readonly _tag: string }) {
  const schema = app.byTag.get(event._tag)

  // The types only let registered events through, so one with no schema here is a defect.
  if (schema === undefined) return yield* Effect.die(`${event._tag} isn't one of this assistant's events.`)

  const json = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(event)

  return yield* Schema.decodeUnknownEffect(AssistantEvent.StoredAppEvent)(json)
}, Effect.orDie)

/** @internal */
export const isRegistered = (app: AppEvents, event: { readonly _tag: string }): boolean => app.byTag.has(event._tag)

// The app's schema decodes the event as the app wrote it.
const unmarked = (event: { readonly _tag: string }) =>
  Predicate.hasProperty(event, inputKey) ? Record.remove(event, inputKey) : event

const decodeEvent = (app: AppEvents, event: { readonly _tag: string }): Option.Option<{ readonly _tag: string }> => {
  const schema = app.byTag.get(event._tag)

  return schema === undefined ? Option.none() : Schema.decodeUnknownOption(Schema.toCodecJson(schema))(unmarked(event))
}

// What came in through `submit`, from outside a turn, is an input: it wakes a turn.
/** @internal */
export const markInput = (event: AssistantEvent.StoredAppEvent): AssistantEvent.StoredAppEvent => ({
  ...event,
  [inputKey]: true
})

// An app event that doesn't decode (say, one from an older version of its schema) is left out.
/** @internal */
export const decodeEntry = (app: AppEvents, entry: AssistantEvent.AnyEntry): Option.Option<Assistant.Entry<any>> => {
  const { event } = entry

  if (AssistantEvent.isLibraryEvent(event)) return Option.some({ ...toEntry(entry), event })

  return Option.map(decodeEvent(app, event), (decoded) => ({ ...toEntry(entry), event: decoded }))
}

/** @internal */
export const decodeEntries = (
  app: AppEvents,
  entries: ReadonlyArray<AssistantEvent.AnyEntry>
): ReadonlyArray<Assistant.Entry<any>> => entries.flatMap((entry) => Option.toArray(decodeEntry(app, entry)))

/** @internal */
export type DecodedEntries = ReturnType<typeof decodeEntries>

const toEntry = (entry: AssistantEvent.AnyEntry) => ({
  chatId: entry.chatId,
  seq: entry.seq,
  at: entry.at
})

// Decoded or as stored, an event's JSON is its schema's encoding; one no schema here knows is already JSON.
/** @internal */
export const toJson = (events: ReadonlyArray<AssistantEvent.AppEventSchema>, event: { readonly _tag: string }) => {
  const schema = events.find((candidate) => tagOf(candidate) === event._tag)

  const encoded = schema === undefined ? Option.none() : Schema.encodeUnknownOption(Schema.toCodecJson(schema))(event)

  return Option.getOrElse(encoded, () => anyToJson(unmarked(event)))
}
