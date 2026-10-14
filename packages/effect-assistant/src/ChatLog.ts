/**
 * This module provides the `ChatLog` service, which stores each chat as an append-only list of
 * `AssistantEvent`s.
 *
 * A log is built on a {@link Storage}. {@link layerMemory} keeps every chat in memory, for tests
 * and local runs, and {@link layerSql} stores chats in a SQL table so they survive restarts. To
 * use another store, implement a `Storage` and pass it to {@link make}.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import * as AssistantEvent from "./AssistantEvent.ts"
import { ChatId } from "./ChatId.ts"

/**
 * Service that stores each chat's events as an ordered list of entries.
 *
 * @category services
 * @since 0.1.0
 */
export class ChatLog extends Context.Service<
  ChatLog,
  {
    /** Appends events to a chat and returns them as stored entries. */
    readonly append: (
      chatId: ChatId,
      events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>
    ) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
    /** Reads a chat's stored entries in order, either all of them or only those after a `sequence`. */
    readonly read: (chatId: ChatId, options?: ReadOptions) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
    /**
     * Returns the chats whose last entry ends neither a turn nor the chat. After a restart, these
     * are the chats that may still owe a turn.
     */
    readonly unfinished: Effect.Effect<ReadonlyArray<ChatId>>
  }
>()("effect-assistant/ChatLog") {}

/**
 * Represents the options that select which of a chat's entries to read.
 *
 * @category models
 * @since 0.1.0
 */
export interface ReadOptions {
  /** Reads only the entries after this `sequence`. */
  readonly after?: number | undefined
}

/**
 * Represents the storage that a `ChatLog` is built on.
 *
 * A storage reads a chat's entries, finds a chat's last `sequence`, writes new entries, and finds every
 * chat's last entry. Entries are never removed, so a deleted chat keeps its log, which ends in
 * `ChatDeleted`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Storage {
  readonly read: (chatId: ChatId, options?: ReadOptions) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
  readonly lastSequence: (chatId: ChatId) => Effect.Effect<number>
  readonly write: (chatId: ChatId, entries: ReadonlyArray<AssistantEvent.Entry>) => Effect.Effect<void>
  /** Returns the last entry of every chat. */
  readonly lastEntries: Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
}

/**
 * Creates a `ChatLog` from a {@link Storage}. `append` numbers new entries after the chat's last
 * `sequence` and stamps them with the current time.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (storage: Storage): ChatLog["Service"] =>
  ChatLog.of({
    read: storage.read,
    append: Effect.fn("ChatLog.append")(function* (
      chatId: ChatId,
      events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>
    ) {
      if (events.length === 0) return []

      const sequence = yield* storage.lastSequence(chatId)
      const at = yield* Clock.currentTimeMillis

      const entries = events.map((event, n) =>
        AssistantEvent.Entry.make({ chatId, sequence: sequence + n + 1, at, event })
      )

      yield* storage.write(chatId, entries)

      return entries
    }),
    unfinished: Effect.gen(function* () {
      const last = yield* storage.lastEntries

      // A deleted chat owes nothing.
      return last.flatMap((entry) =>
        AssistantEvent.isTurnEnd(entry.event) || Predicate.isTagged(entry.event, "ChatDeleted") ? [] : [entry.chatId]
      )
    })
  })

/**
 * Layer that keeps every chat in memory. The log is lost when the process stops.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory: Layer.Layer<ChatLog> = Layer.effect(
  ChatLog,
  Effect.gen(function* () {
    const chats = yield* Ref.make(new Map<ChatId, ReadonlyArray<AssistantEvent.Entry>>())

    return make({
      read: Effect.fnUntraced(function* (chatId: ChatId, options?: ReadOptions) {
        const all = yield* Ref.get(chats)

        return (all.get(chatId) ?? []).filter((entry) => entry.sequence > (options?.after ?? 0))
      }),
      lastSequence: Effect.fnUntraced(function* (chatId: ChatId) {
        const all = yield* Ref.get(chats)

        return all.get(chatId)?.at(-1)?.sequence ?? 0
      }),
      write: (chatId, entries) =>
        Ref.update(chats, (all) => new Map(all).set(chatId, [...(all.get(chatId) ?? []), ...entries])),
      lastEntries: Effect.gen(function* () {
        const all = yield* Ref.get(chats)

        return [...all.values()].flatMap((entries) => entries.slice(-1))
      })
    })
  })
)

const EventJson = Schema.fromJsonString(Schema.Union([AssistantEvent.AssistantEvent, AssistantEvent.StoredAppEvent]))

// Postgres returns BIGINT and DOUBLE PRECISION columns as strings; other databases as numbers.
const SqlNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])

const Row = Schema.Struct({ chat_id: ChatId, sequence: SqlNumber, at: SqlNumber, event: EventJson })

const decodeLastSequence = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ sequence: Schema.NullOr(SqlNumber) }))
)

/**
 * Layer that stores chats in a SQL table named `chat_log`.
 *
 * **Details**
 *
 * The table must already exist. It has the columns `chat_id`, `sequence`, `at`, and `event`, with the
 * primary key `(chat_id, sequence)`. The layer requires a `SqlClient`.
 *
 * **Example** (Storing chats in Postgres)
 *
 * ```ts
 * import * as PgClient from "@effect/sql-pg/PgClient"
 * import { ChatLog } from "effect-assistant"
 * import * as Config from "effect/Config"
 * import * as Layer from "effect/Layer"
 *
 * const ChatLogLive = ChatLog.layerSql.pipe(
 *   Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }))
 * )
 * ```
 *
 * The table, in Postgres:
 *
 * ```sql
 * CREATE TABLE chat_log (
 *   chat_id TEXT NOT NULL,
 *   sequence INTEGER NOT NULL,
 *   at DOUBLE PRECISION NOT NULL,
 *   event TEXT NOT NULL,
 *   PRIMARY KEY (chat_id, sequence)
 * );
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSql: Layer.Layer<ChatLog, never, SqlClient.SqlClient> = Layer.effect(
  ChatLog,
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()

    const toEntries = Effect.fnUntraced(function* (rows: ReadonlyArray<unknown>) {
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows)

      return decoded.map((row) =>
        AssistantEvent.Entry.make({
          chatId: row.chat_id,
          sequence: row.sequence,
          at: row.at,
          event: row.event
        })
      )
    })

    const encodeEvent = Schema.encodeEffect(EventJson)

    return make({
      read: Effect.fnUntraced(function* (chatId: ChatId, options?: ReadOptions) {
        const rows = yield* sql`
          SELECT chat_id, sequence, at, event FROM chat_log WHERE chat_id = ${chatId} AND sequence > ${options?.after ?? 0} ORDER BY sequence
        `

        return yield* toEntries(rows)
      }, Effect.orDie),
      lastSequence: Effect.fnUntraced(function* (chatId: ChatId) {
        const result = yield* sql`
          SELECT MAX(sequence) AS sequence FROM chat_log WHERE chat_id = ${chatId}
        `

        const rows = yield* decodeLastSequence(result)

        return rows[0]?.sequence ?? 0
      }, Effect.orDie),
      write: Effect.fnUntraced(function* (chatId: ChatId, entries: ReadonlyArray<AssistantEvent.Entry>) {
        const rows = yield* Effect.forEach(
          entries,
          Effect.fnUntraced(function* (entry: AssistantEvent.Entry) {
            const event = yield* encodeEvent(entry.event)

            return { chat_id: chatId, sequence: entry.sequence, at: entry.at, event }
          })
        )

        yield* sql`INSERT INTO chat_log ${sql.insert(rows)}`
      }, Effect.orDie),
      lastEntries: Effect.gen(function* () {
        const rows = yield* sql`
          SELECT e.chat_id, e.sequence, e.at, e.event FROM chat_log e
          JOIN (SELECT chat_id, MAX(sequence) AS sequence FROM chat_log GROUP BY chat_id) last
            ON last.chat_id = e.chat_id AND last.sequence = e.sequence
        `

        return yield* toEntries(rows)
      }).pipe(Effect.orDie)
    })
  })
)
