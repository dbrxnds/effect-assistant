/**
 * The `Memory` module is what an assistant remembers across chats, in three
 * kinds:
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
import * as SqlClient from "effect/sql/SqlClient"
import { AssistantChat } from "./AssistantChat.ts"
import * as AssistantLoop from "./AssistantLoop.ts"
import { ChatId } from "./ChatId.ts"
import * as Uuid from "./internal/uuid.ts"
import * as ToolFailure from "./ToolFailure.ts"

/**
 * What kind of fact: lasting (`profile`), what happened in a chat (`log`),
 * or short-lived (`note`).
 */
export const Kind = Schema.Literals(["profile", "log", "note"])

export type Kind = typeof Kind.Type

/**
 * A fact the assistant remembers: its text, the scope it's in, the chat it
 * came from, when it was written, and when it expires (never, for most).
 */
export class Fact extends Schema.Class<Fact>("effect-assistant/Memory/Fact")({
  id: Schema.String,
  scope: Schema.String,
  kind: Kind,
  text: Schema.String,
  chatId: Schema.NullOr(ChatId),
  at: Schema.Finite,
  expiresAt: Schema.NullOr(Schema.Finite)
}) {}

/**
 * Where facts go and whom they're read for: the user's own scope, and the
 * one their team shares, if any. The app chooses the keys; a turn reads both.
 */
export interface Scopes {
  readonly personal: string
  readonly shared?: string | undefined
}

const scopeKeys = (scopes: Scopes): ReadonlyArray<string> =>
  scopes.shared === undefined ? [scopes.personal] : [scopes.personal, scopes.shared]

/** Stores facts per scope. */
export class MemoryStore extends Context.Service<
  MemoryStore,
  {
    /** Writes the fact, replacing the one with its id. */
    readonly put: (fact: Fact) => Effect.Effect<void>
    /** Removes the fact if it's in one of the scopes; whether it was there. */
    readonly remove: (scopes: ReadonlyArray<string>, id: string) => Effect.Effect<boolean>
    /** The facts in the scopes that haven't expired at `now`, newest first. */
    readonly list: (scopes: ReadonlyArray<string>, now: number) => Effect.Effect<ReadonlyArray<Fact>>
  }
>()("effect-assistant/Memory/MemoryStore") {}

const live = (fact: Fact, now: number) => fact.expiresAt === null || fact.expiresAt > now

const newestFirst = (a: Fact, b: Fact) => b.at - a.at

/** A store in memory, for tests and local development. */
export const layerMemory: Layer.Layer<MemoryStore> = Layer.effect(
  MemoryStore,
  Effect.gen(function* () {
    const facts = yield* Ref.make(new Map<string, Fact>())

    return MemoryStore.of({
      put: (fact) => Ref.update(facts, (all) => new Map(all).set(fact.id, fact)),
      remove: (scopes, id) =>
        Ref.modify(facts, (all) => {
          const fact = all.get(id)

          if (fact === undefined || !scopes.includes(fact.scope)) return [false, all]

          const next = new Map(all)
          next.delete(id)

          return [true, next]
        }),
      list: Effect.fnUntraced(function* (scopes: ReadonlyArray<string>, now: number) {
        const all = yield* Ref.get(facts)

        return [...all.values()].filter((fact) => scopes.includes(fact.scope) && live(fact, now)).sort(newestFirst)
      })
    })
  })
)

const Row = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  kind: Kind,
  text: Schema.String,
  chat_id: Schema.NullOr(ChatId),
  // Postgres drivers hand DOUBLE PRECISION back as a number or as its text.
  at: Schema.Union([Schema.Finite, Schema.NumberFromString]),
  expires_at: Schema.NullOr(Schema.Union([Schema.Finite, Schema.NumberFromString]))
})

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))

/**
 * A store in SQL, in a `memory_facts` table (`id` primary key, `scope`, `kind`,
 * `text`, `chat_id` nullable, `at`, `expires_at` nullable) that must exist.
 */
export const layerSql: Layer.Layer<MemoryStore, never, SqlClient.SqlClient> = Layer.effect(
  MemoryStore,
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()

    return MemoryStore.of({
      put: Effect.fnUntraced(
        function* (fact: Fact) {
          yield* sql`DELETE FROM memory_facts WHERE id = ${fact.id}`
          yield* sql`INSERT INTO memory_facts ${sql.insert({
            id: fact.id,
            scope: fact.scope,
            kind: fact.kind,
            text: fact.text,
            chat_id: fact.chatId,
            at: fact.at,
            expires_at: fact.expiresAt
          })}`
        },
        sql.withTransaction,
        Effect.orDie
      ),
      remove: Effect.fnUntraced(
        function* (scopes: ReadonlyArray<string>, id: string) {
          const found = yield* sql`
            SELECT id FROM memory_facts WHERE id = ${id} AND ${sql.in("scope", scopes)}
          `

          if (found.length === 0) return false

          yield* sql`DELETE FROM memory_facts WHERE id = ${id}`

          return true
        },
        sql.withTransaction,
        Effect.orDie
      ),
      list: Effect.fnUntraced(function* (scopes: ReadonlyArray<string>, now: number) {
        const result = yield* sql`
          SELECT id, scope, kind, text, chat_id, at, expires_at FROM memory_facts
          WHERE ${sql.in("scope", scopes)} AND (expires_at IS NULL OR expires_at > ${now})
          ORDER BY at DESC
        `

        const rows = yield* decodeRows(result)

        return rows.map(
          (row) =>
            new Fact({
              id: row.id,
              scope: row.scope,
              kind: row.kind,
              text: row.text,
              chatId: row.chat_id,
              at: row.at,
              expiresAt: row.expires_at
            })
        )
      }, Effect.orDie)
    })
  })
)

/**
 * The facts the scopes have now, newest first. `exceptLogOf` leaves out that
 * chat's own log line: the chat has itself, and a line that got something
 * wrong would otherwise tell it so.
 */
export const facts: (
  scopes: Scopes,
  options?: { readonly exceptLogOf?: ChatId | undefined }
) => Effect.Effect<ReadonlyArray<Fact>, never, MemoryStore> = Effect.fn("Memory.facts")(function* (
  scopes: Scopes,
  options?: { readonly exceptLogOf?: ChatId | undefined }
) {
  const store = yield* MemoryStore
  const all = yield* store.list(scopeKeys(scopes), yield* Clock.currentTimeMillis)

  return options?.exceptLogOf === undefined
    ? all
    : all.filter((fact) => !(fact.kind === "log" && fact.chatId === options.exceptLogOf))
})

const day = (millis: number): string => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(millis))

/** Options for {@link render}. */
export interface RenderOptions {
  /** How many log lines, newest first. Default 10; older ones stay findable with `recall`. */
  readonly logLines?: number | undefined
}

/**
 * The facts as the model reads them, or none when there are none: profile
 * facts and notes with their ids (so it can replace or forget them), and the
 * newest log lines, each dated.
 */
export const render = (facts: ReadonlyArray<Fact>, scopes: Scopes, options?: RenderOptions): Option.Option<string> => {
  const whose = (fact: Fact) => (fact.scope === scopes.personal ? "" : " (team)")
  const ofKind = (kind: Kind) => facts.filter((fact) => fact.kind === kind)

  const profile = ofKind("profile").map((fact) => `- [${fact.id}] ${fact.text}${whose(fact)}`)

  const notes = ofKind("note").map(
    (fact) =>
      `- [${fact.id}] ${fact.text}${whose(fact)}${fact.expiresAt === null ? "" : ` (until ${day(fact.expiresAt)})`}`
  )

  const log = ofKind("log")
    .slice(0, options?.logLines ?? 10)
    .map((fact) => `- ${day(fact.at)}: ${fact.text}`)

  const sections = [
    profile.length > 0 ? `About them:\n${profile.join("\n")}` : "",
    notes.length > 0 ? `Notes:\n${notes.join("\n")}` : "",
    log.length > 0 ? `Earlier chats, newest first:\n${log.join("\n")}` : ""
  ].filter((section) => section.length > 0)

  return sections.length === 0
    ? Option.none()
    : Option.some(
        `<memory>\nWhat you remember from earlier chats. Use it without saying where it came from; when their data or what they say now disagrees, that wins.\n\n${sections.join("\n\n")}\n</memory>`
      )
}

/**
 * Writes the chat's log line: one per chat, replacing the one it had, dated
 * now, in the user's own scope.
 */
export const log: (scopes: Scopes, chatId: ChatId, text: string) => Effect.Effect<void, never, MemoryStore> = Effect.fn(
  "Memory.log"
)(function* (scopes: Scopes, chatId: ChatId, text: string) {
  const store = yield* MemoryStore

  yield* store.put(
    new Fact({
      id: `log-${chatId}`,
      scope: scopes.personal,
      kind: "log",
      text,
      chatId,
      at: yield* Clock.currentTimeMillis,
      expiresAt: null
    })
  )
})

// How long a note lasts when the model doesn't say.
const NOTE_DAYS = 14

const DAY_MILLIS = 24 * 60 * 60 * 1000

const Remember = Tool.make("remember", {
  description: `Remember something for later chats. Only what you can't look up again and that will still matter: a preference, a standing decision, how they like to work ("Rotterdam's copy is always Dutch"), as kind profile; short-lived context ("out of office until Friday") as kind note, which expires. Not records your tools can read (orders, locations, budgets, people), not the state of a task in progress, and nothing you'd only need in this chat. One fact per call, in one short sentence that stands on its own. When it changes one you already have, pass that one's id as replaces.`,
  parameters: Schema.Struct({
    text: Schema.String,
    kind: Schema.Literals(["profile", "note"]),
    team: Schema.optional(Schema.Boolean).annotate({
      description: "True when it's about their whole team, not just them, and they said so. Default false."
    }),
    until: Schema.optional(Schema.String).annotate({
      description: `For a note: the last day it matters, as YYYY-MM-DD. Default ${NOTE_DAYS} days from now.`
    }),
    replaces: Schema.optional(Schema.String).annotate({
      description: "The id of a fact this one replaces."
    })
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
  dependencies: [MemoryStore]
})

const Recall = Tool.make("recall", {
  description:
    "Search what you remember, including earlier chats older than the ones you're shown, by words that would be in it.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Array(Schema.String),
  failure: ToolFailure.ToolFailure,
  dependencies: [MemoryStore]
})

const MemoryToolkit = Toolkit.make(Remember, Forget, Recall)

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

const lastDay = (until: string): Option.Option<number> =>
  Option.map(DateTime.make(`${until}T23:59:59Z`), DateTime.toEpochMillis)

/**
 * The `remember`, `forget` and `recall` tools, over these scopes. They need
 * the {@link MemoryStore}.
 */
export const makeToolkit = (scopes: Scopes): AssistantLoop.Tools<MemoryStore | AssistantChat> =>
  AssistantLoop.fromToolkit(MemoryToolkit, {
    remember: Effect.fnUntraced(function* ({ text, kind, team, until, replaces }) {
      const store = yield* MemoryStore
      const chat = yield* AssistantChat
      const now = yield* Clock.currentTimeMillis
      const scope = team === true ? scopes.shared : scopes.personal

      if (scope === undefined) {
        return yield* ToolFailure.fail("There's no team memory here: remember it for them.")
      }

      const expiresAt =
        kind === "profile"
          ? Option.none<number>()
          : until === undefined
            ? Option.some(now + NOTE_DAYS * DAY_MILLIS)
            : lastDay(until)

      if (kind === "note" && Option.isNone(expiresAt)) {
        return yield* ToolFailure.fail(`until must be a date as YYYY-MM-DD, not ${until}.`)
      }

      const existing = yield* store.list(scopeKeys(scopes), now)
      const same = existing.find((fact) => fact.scope === scope && fact.text.trim() === text.trim())

      if (replaces !== undefined) yield* store.remove(scopeKeys(scopes), replaces)

      const id = same?.id ?? `f-${(yield* Uuid.make).slice(0, 8)}`

      yield* store.put(
        new Fact({
          id,
          scope,
          kind,
          text: text.trim(),
          chatId: chat.chatId,
          at: now,
          expiresAt: Option.getOrNull(expiresAt)
        })
      )

      return `Remembered as ${id}.`
    }),
    forget: Effect.fnUntraced(function* ({ id }) {
      const store = yield* MemoryStore

      return (yield* store.remove(scopeKeys(scopes), id))
        ? `Forgot ${id}.`
        : yield* ToolFailure.fail(`Nothing remembered as ${id}.`)
    }),
    recall: Effect.fnUntraced(function* ({ query }) {
      const all = yield* facts(scopes)
      const wanted = words(query)

      return all
        .map((fact) => ({ fact, score: matches(fact, wanted) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || newestFirst(a.fact, b.fact))
        .slice(0, 10)
        .map(({ fact }) =>
          fact.kind === "log"
            ? `${day(fact.at)} (chat): ${fact.text}`
            : `[${fact.id}] ${fact.text} (${fact.kind}${fact.scope === scopes.personal ? "" : ", team"})`
        )
    })
  })
