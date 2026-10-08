import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as AppEvent from "../AppEvent.ts"
import type * as Assistant from "../Assistant.ts"
import * as AssistantEvent from "../AssistantEvent.ts"
import { toJsonText } from "./schema.ts"

/** @internal */
export interface AppEvents {
  readonly byTag: ReadonlyMap<string, Registered>
  readonly wakes: ReadonlySet<string>
}

interface Registered {
  readonly schema: AppEvent.EventSchema
  readonly render: AppEvent.Render<{ readonly _tag: string }> | undefined
}

/** @internal */
export const make = (events: ReadonlyArray<AppEvent.Any>): AppEvents => {
  const byTag = new Map(
    events.map((event): [string, Registered] => [event.tag, { schema: event.schema, render: event.render }])
  )

  for (const tag of byTag.keys()) {
    if (AssistantEvent.isLibraryEvent({ _tag: tag })) throw new Error(`${tag} is one of the library's events.`)
  }

  if (byTag.size !== events.length) throw new Error("An assistant's events have different tags.")

  return { byTag, wakes: new Set(events.flatMap((event) => (event.wakes ? [event.tag] : []))) }
}

/** @internal */
export const encode = Effect.fnUntraced(function* (app: AppEvents, event: { readonly _tag: string }) {
  const registered = app.byTag.get(event._tag)

  // The types only let registered events through, so one with no schema here is a defect.
  if (registered === undefined) return yield* Effect.die(`${event._tag} isn't one of this assistant's events.`)

  const json = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(registered.schema))(event)

  return yield* Schema.decodeUnknownEffect(AssistantEvent.StoredAppEvent)(json)
}, Effect.orDie)

/** @internal */
export const isRegistered = (app: AppEvents, event: { readonly _tag: string }): boolean => app.byTag.has(event._tag)

// An app event that doesn't decode (say, one from an older version of its schema) is left out.
/** @internal */
export const decodeEntry = (app: AppEvents, entry: AssistantEvent.AnyEntry): Option.Option<Assistant.Entry<any>> => {
  const { event } = entry

  if (AssistantEvent.isLibraryEvent(event)) return Option.some({ ...toEntry(entry), event })

  const registered = app.byTag.get(event._tag)

  if (registered === undefined) return Option.none()

  return Option.map(Schema.decodeUnknownOption(Schema.toCodecJson(registered.schema))(event), (decoded) => ({
    ...toEntry(entry),
    event: decoded
  }))
}

/** @internal */
export const decodeEntries = (
  app: AppEvents,
  entries: ReadonlyArray<AssistantEvent.AnyEntry>
): ReadonlyArray<Assistant.Entry<any>> => entries.flatMap((entry) => Option.toArray(decodeEntry(app, entry)))

const decodeStored = Schema.decodeUnknownOption(AssistantEvent.StoredAppEvent)

const toEntry = (entry: AssistantEvent.AnyEntry) => ({
  chatId: entry.chatId,
  seq: entry.seq,
  at: entry.at
})

/** @internal */
export const read = (app: AppEvents, event: { readonly _tag: string }): string | undefined => {
  const registered = app.byTag.get(event._tag)

  if (registered?.render === undefined) return undefined

  if (registered.render !== "json") return registered.render(event)

  const stored = Schema.encodeUnknownOption(Schema.toCodecJson(registered.schema))(event).pipe(
    Option.flatMap(decodeStored)
  )

  return Option.match(stored, {
    onNone: () => undefined,
    onSome: ({ _tag, ...fields }) => `<${_tag}>\n${toJsonText(fields)}\n</${_tag}>`
  })
}
