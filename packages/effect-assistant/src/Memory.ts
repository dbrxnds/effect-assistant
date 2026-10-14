/**
 * Keeps facts an assistant remembers across chats.
 *
 * The model keeps facts with the `remember` tool, finds them with `recall`, and drops them with
 * `forget` ({@link Tools}). Where facts are stored and who shares them is up to the application,
 * which implements {@link MemoryStore}; every method receives the chat it's for. {@link render}
 * shows the facts in a turn's instructions.
 *
 * @since 0.1.0
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
import type { ChatId } from "./ChatId.ts"
import { CurrentChat } from "./CurrentChat.ts"
import * as Uuid from "./internal/uuid.ts"
import * as ToolFailure from "./ToolFailure.ts"

/**
 * Represents a fact the assistant remembers.
 *
 * It holds the fact's id, one short sentence, and when the fact stops mattering, if it does.
 *
 * @category schemas
 * @since 0.1.0
 */
export class Fact extends Schema.Class<Fact>("effect-assistant/Memory/Fact")({
  id: Schema.String,
  text: Schema.String,
  expiresAt: Schema.optional(Schema.DateTimeUtc)
}) {}

/**
 * Represents a fact to keep, as the `remember` tool hands it to the store.
 *
 * @category models
 * @since 0.1.0
 */
export interface NewFact {
  readonly text: string
  readonly expiresAt?: DateTime.Utc | undefined
  /** The id of a fact this one replaces. */
  readonly replaces?: string | undefined
}

/**
 * Service that keeps facts, implemented by the application.
 *
 * Every method receives the chat it's for, and the application decides whose facts that means
 * (the chat's user, their team, ...).
 *
 * @category services
 * @since 0.1.0
 */
export class MemoryStore extends Context.Service<
  MemoryStore,
  {
    /** Returns the unexpired facts a chat should know. */
    readonly facts: (chatId: ChatId) => Effect.Effect<ReadonlyArray<Fact>>
    /** Keeps a fact for the chat's owner, and returns its id. */
    readonly remember: (chatId: ChatId, fact: NewFact) => Effect.Effect<string>
    /**
     * Drops a fact. Fails with a message for the model when the chat's owner has no fact with
     * that id.
     */
    readonly forget: (chatId: ChatId, id: string) => Effect.Effect<void, ToolFailure.ToolFailure>
    /** Returns the chat owner's facts that match a query, best first. */
    readonly recall: (chatId: ChatId, query: string) => Effect.Effect<ReadonlyArray<Fact>>
  }
>()("effect-assistant/Memory/MemoryStore") {}

const day = (at: DateTime.Utc): string => DateTime.formatIsoDateUtc(at)

const line = (fact: Fact): string =>
  `- [${fact.id}] ${fact.text}${fact.expiresAt === undefined ? "" : ` (until ${day(fact.expiresAt)})`}`

/**
 * Renders facts as the model reads them, for a turn's instructions.
 *
 * Each fact is listed with its id, so the model can replace or forget it. The result is an empty
 * string when there are no facts.
 *
 * @see {@link Tools} for an example
 *
 * @category utils
 * @since 0.1.0
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

const matches = (fact: Fact, query: ReadonlyArray<string>): number => {
  const own = words(fact.text)

  return query.filter((word) => own.some((w) => w.startsWith(word) || word.startsWith(w))).length
}

const live = (now: number) => (fact: Fact) =>
  fact.expiresAt === undefined || DateTime.toEpochMillis(fact.expiresAt) > now

/**
 * Layer that provides a {@link MemoryStore} in memory, for tests and local runs.
 *
 * Every chat shares one set of facts.
 *
 * @category layers
 * @since 0.1.0
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
  dependencies: [CurrentChat, MemoryStore]
})

const Forget = Tool.make("forget", {
  description: "Forget a fact you remember, by its id, when they ask or it's no longer true.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  failure: ToolFailure.ToolFailure,
  dependencies: [CurrentChat, MemoryStore]
})

const Recall = Tool.make("recall", {
  description: "Search what you remember, by words that would be in it.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Array(Schema.String),
  failure: ToolFailure.ToolFailure,
  dependencies: [CurrentChat, MemoryStore]
})

/**
 * Toolkit with the `remember`, `forget`, and `recall` tools.
 *
 * **Details**
 *
 * Merge it into the loop's toolkit, and provide {@link layerTools} and a {@link MemoryStore}. Show
 * the facts in the turn's instructions with {@link render}.
 *
 * **Example** (Giving an assistant memory)
 *
 * ```ts
 * import { Assistant, Memory } from "effect-assistant"
 * import * as Effect from "effect/Effect"
 * import * as Layer from "effect/Layer"
 * import * as Stream from "effect/Stream"
 *
 * export const MyAssistant = Assistant.make("my-assistant")
 *
 * const MyAssistantLive = MyAssistant.toLayer(
 *   Effect.gen(function* () {
 *     const memory = yield* Memory.MemoryStore
 *
 *     return (turn) =>
 *       Stream.unwrap(
 *         Effect.map(memory.facts(turn.chatId), (facts) =>
 *           turn.run({
 *             instructions: `You help a small team.\n\n${Memory.render(facts)}`,
 *             toolkit: Memory.Tools
 *           })
 *         )
 *       ).pipe(Stream.provideService(Memory.MemoryStore, memory))
 *   })
 * ).pipe(Layer.provide(Memory.layerTools), Layer.provide(Memory.layerMemory))
 * ```
 *
 * @category tools
 * @since 0.1.0
 */
export const Tools = Toolkit.make(Remember, Forget, Recall)

const endOf = (date: string): Option.Option<DateTime.Utc> =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) ? DateTime.make(`${date}T23:59:59Z`) : Option.none()

/**
 * Layer that provides the handlers of {@link Tools}.
 *
 * The handlers call the {@link MemoryStore} with the chat they run in.
 *
 * @see {@link Tools} for an example
 *
 * @category layers
 * @since 0.1.0
 */
export const layerTools = Tools.toLayer({
  remember: Effect.fnUntraced(function* ({ text, until, replaces }) {
    const chat = yield* CurrentChat
    const store = yield* MemoryStore
    const expiresAt = until === undefined ? Option.none() : endOf(until)

    if (until !== undefined && Option.isNone(expiresAt)) {
      return yield* ToolFailure.fail(`until must be a date as YYYY-MM-DD, not ${until}.`)
    }

    const id = yield* store.remember(chat.chatId, { text, expiresAt: Option.getOrUndefined(expiresAt), replaces })

    return `Remembered as ${id}.`
  }),
  forget: Effect.fnUntraced(function* ({ id }) {
    const chat = yield* CurrentChat

    yield* (yield* MemoryStore).forget(chat.chatId, id)

    return `Forgot ${id}.`
  }),
  recall: Effect.fnUntraced(function* ({ query }) {
    const chat = yield* CurrentChat
    const found = yield* (yield* MemoryStore).recall(chat.chatId, query)

    return found.map(line)
  })
})
