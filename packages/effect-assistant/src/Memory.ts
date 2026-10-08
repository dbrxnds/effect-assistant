/**
 * The `Memory` module is what an assistant remembers across chats: facts the
 * model keeps with `remember`, finds with `recall`, and drops with `forget`.
 * Where they're stored and who shares them is the app's: it implements
 * {@link MemoryStore}, whose every method gets the chat it's for. Show the
 * facts in a turn's instructions with {@link render}.
 */
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { AssistantChat } from "./AssistantChat.ts"
import type { ChatId } from "./ChatId.ts"
import * as Uuid from "./internal/uuid.ts"
import * as ToolFailure from "./ToolFailure.ts"

/** A fact the assistant remembers: its id, one short sentence, and when it stops mattering, if it does. */
export class Fact extends Schema.Class<Fact>("effect-assistant/Memory/Fact")({
  id: Schema.String,
  text: Schema.String,
  expiresAt: Schema.optional(Schema.DateTimeUtc)
}) {}

/** A fact to keep, as the `remember` tool hands it to the store. */
export interface NewFact {
  readonly text: string
  readonly expiresAt?: DateTime.Utc | undefined
  /** The id of a fact this one replaces. */
  readonly replaces?: string | undefined
}

/**
 * Where facts are kept: the app's. Every method gets the chat it's for, and
 * the app decides whose facts that means (the chat's user, their team, ...).
 */
export class MemoryStore extends Context.Service<
  MemoryStore,
  {
    /** The facts a chat should know, unexpired. */
    readonly facts: (chatId: ChatId) => Effect.Effect<ReadonlyArray<Fact>>
    /** Keeps a fact for the chat's owner, and returns its id. */
    readonly remember: (chatId: ChatId, fact: NewFact) => Effect.Effect<string>
    /** Drops a fact; fails, for the model to read, when the chat's owner has no fact with that id. */
    readonly forget: (chatId: ChatId, id: string) => Effect.Effect<void, ToolFailure.ToolFailure>
    /** The chat owner's facts that match a query, best first. */
    readonly recall: (chatId: ChatId, query: string) => Effect.Effect<ReadonlyArray<Fact>>
  }
>()("effect-assistant/Memory/MemoryStore") {}

const day = (at: DateTime.Utc): string => DateTime.formatIsoDateUtc(at)

const line = (fact: Fact): string =>
  `- [${fact.id}] ${fact.text}${fact.expiresAt === undefined ? "" : ` (until ${day(fact.expiresAt)})`}`

/**
 * The facts as the model reads them, for a turn's instructions: each with
 * its id, so it can replace or forget one. Empty when there are none.
 */
export const render = (facts: ReadonlyArray<Fact>): string =>
  facts.length === 0
    ? ""
    : `<memory>\nWhat you remember from earlier chats. Use it without saying where it came from; when their data or what they say now disagrees, that wins.\n${facts.map(line).join("\n")}\n</memory>`

const words = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2)

/** How many of the query's words the fact has; a word counts when one starts with the other. */
const matches = (fact: Fact, query: ReadonlyArray<string>): number => {
  const own = words(fact.text)

  return query.filter((word) => own.some((w) => w.startsWith(word) || word.startsWith(w))).length
}

const live = (now: number) => (fact: Fact) =>
  fact.expiresAt === undefined || DateTime.toEpochMillis(fact.expiresAt) > now

/**
 * A store in memory, for tests and local runs: one set of facts that every
 * chat shares.
 */
export const layerMemory: Layer.Layer<MemoryStore> = Layer.effect(
  MemoryStore,
  Effect.gen(function* () {
    // Newest first.
    const all = yield* Ref.make<ReadonlyArray<Fact>>([])

    const current = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis

      return (yield* Ref.get(all)).filter(live(now))
    })

    return MemoryStore.of({
      facts: () => current,
      remember: Effect.fnUntraced(function* (_chatId: ChatId, fact: NewFact) {
        const same = (yield* current).find((kept) => kept.text === fact.text.trim())
        const id = same?.id ?? `f-${(yield* Uuid.make).slice(0, 8)}`
        const kept = new Fact({ id, text: fact.text.trim(), expiresAt: fact.expiresAt })

        yield* Ref.update(all, (facts) => [kept, ...facts.filter((old) => old.id !== id && old.id !== fact.replaces)])

        return id
      }),
      forget: Effect.fnUntraced(function* (_chatId: ChatId, id: string) {
        if (!(yield* current).some((fact) => fact.id === id))
          return yield* ToolFailure.fail(`Nothing remembered as ${id}.`)

        yield* Ref.update(all, (facts) => facts.filter((fact) => fact.id !== id))
      }),
      recall: Effect.fnUntraced(function* (_chatId: ChatId, query: string) {
        const wanted = words(query)

        return (yield* current)
          .map((fact) => ({ fact, score: matches(fact, wanted) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10)
          .map(({ fact }) => fact)
      })
    })
  })
)

const Remember = Tool.make("remember", {
  description: `Remember something for later chats. Only what you can't look up again and that will still matter: a preference, a standing decision, how they like to work ("Rotterdam's copy is always Dutch"). For something short-lived ("out of office until Friday"), pass until. Not records your tools can read (orders, locations, budgets, people), not the state of a task in progress, and nothing you'd only need in this chat. One fact per call, in one short sentence that stands on its own. When it changes one you already have, pass that one's id as replaces.`,
  parameters: Schema.Struct({
    text: Schema.String,
    until: Schema.optional(Schema.String).annotate({
      description: "For something short-lived: the last day it matters, as YYYY-MM-DD."
    }),
    replaces: Schema.optional(Schema.String).annotate({ description: "The id of a fact this one replaces." })
  }),
  success: Schema.String,
  failure: ToolFailure.ToolFailure,
  dependencies: [AssistantChat, MemoryStore]
})

const Forget = Tool.make("forget", {
  description: "Forget a fact you remember, by its id, when they ask or it's no longer true.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  failure: ToolFailure.ToolFailure,
  dependencies: [AssistantChat, MemoryStore]
})

const Recall = Tool.make("recall", {
  description: "Search what you remember, by words that would be in it.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Array(Schema.String),
  failure: ToolFailure.ToolFailure,
  dependencies: [AssistantChat, MemoryStore]
})

/**
 * The `remember`, `forget` and `recall` tools. Merge them into the loop's
 * toolkit, and provide {@link layerTools} and a {@link MemoryStore}.
 */
export const Tools = Toolkit.make(Remember, Forget, Recall)

/** The end of the day a `YYYY-MM-DD` names, in UTC. */
const endOf = (date: string): Option.Option<DateTime.Utc> =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) ? DateTime.make(`${date}T23:59:59Z`) : Option.none()

/** Layer for the {@link Tools}' handlers: the {@link MemoryStore}, for the chat they run in. */
export const layerTools = Tools.toLayer({
  remember: Effect.fnUntraced(function* ({ text, until, replaces }) {
    const chat = yield* AssistantChat
    const store = yield* MemoryStore
    const expiresAt = until === undefined ? Option.none() : endOf(until)

    if (until !== undefined && Option.isNone(expiresAt)) {
      return yield* ToolFailure.fail(`until must be a date as YYYY-MM-DD, not ${until}.`)
    }

    const id = yield* store.remember(chat.chatId, { text, expiresAt: Option.getOrUndefined(expiresAt), replaces })

    return `Remembered as ${id}.`
  }),
  forget: Effect.fnUntraced(function* ({ id }) {
    const chat = yield* AssistantChat

    yield* (yield* MemoryStore).forget(chat.chatId, id)

    return `Forgot ${id}.`
  }),
  recall: Effect.fnUntraced(function* ({ query }) {
    const chat = yield* AssistantChat
    const found = yield* (yield* MemoryStore).recall(chat.chatId, query)

    return found.map(line)
  })
})
