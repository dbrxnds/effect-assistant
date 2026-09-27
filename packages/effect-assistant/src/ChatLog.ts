/**
 * The `ChatLog` module stores each chat as an append-only list of
 * `AssistantEvent`s.
 *
 * It's the storage: `append` numbers entries after the chat's last `seq`,
 * and `read` returns them in order, all of them or those after a `seq`. An
 * open chat reads its log once and keeps its entries in memory. The engine's chats write through it one
 * at a time (each chat has a lock) and send new entries to the chat's
 * subscribers; an assistant's `subscribe` streams them. One process writes
 * each chat: the cluster engine sends a chat to one entity.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as AssistantEvent from "./AssistantEvent.ts"
import { ChatId } from "./ChatId.ts"

/**
 * Service that stores each chat's events.
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
      events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.AppEvent>
    ) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
    /** Reads a chat's stored entries, in order: all of them, or those after a `seq`. */
    readonly read: (chatId: ChatId, options?: ReadOptions) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
    /** Chats whose last entry doesn't end a turn: the ones that may still owe one, after a restart. */
    readonly unfinished: Effect.Effect<ReadonlyArray<ChatId>>
  }
>()("effect-assistant/ChatLog") {}

/**
 * Which of a chat's entries to read.
 *
 * @category models
 * @since 0.1.0
 */
export interface ReadOptions {
  /** Only the entries after this `seq`. */
  readonly after?: number | undefined
}

/**
 * The storage a `ChatLog` is built on: read a chat, find its last `seq`,
 * write new entries, and find every chat's last entry.
 *
 * @category models
 * @since 0.1.0
 */
export interface Storage {
  readonly read: (chatId: ChatId, options?: ReadOptions) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
  readonly lastSeq: (chatId: ChatId) => Effect.Effect<number>
  readonly write: (chatId: ChatId, entries: ReadonlyArray<AssistantEvent.Entry>) => Effect.Effect<void>
  /** Every chat's last entry. */
  readonly lastEntries: Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
}

/**
 * Creates a `ChatLog` from a {@link Storage}.
 *
 * **When to use**
 *
 * Use to back the log with a store other than memory or SQL.
 *
 * **Details**
 *
 * `append` numbers entries after the chat's last `seq`. It takes no lock:
 * the engine's chats write through their own, which also sends the entries
 * to the chat's subscribers. Write a chat outside its engine only while
 * nothing else writes it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (storage: Storage): ChatLog["Service"] =>
  ChatLog.of({
    read: storage.read,
    append: Effect.fn(function* (
      chatId: ChatId,
      events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.AppEvent>
    ) {
      if (events.length === 0) return []

      const seq = yield* storage.lastSeq(chatId)
      const at = yield* Clock.currentTimeMillis
      const entries = events.map((event, n) => AssistantEvent.Entry.make({ chatId, seq: seq + n + 1, at, event }))

      yield* storage.write(chatId, entries)

      return entries
    }),
    unfinished: Effect.map(storage.lastEntries, (last) =>
      last.flatMap((entry) => (AssistantEvent.isTurnEnd(entry.event) ? [] : [entry.chatId]))
    )
  })

/**
 * Layer that keeps every chat in memory.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory: Layer.Layer<ChatLog> = Layer.effect(
  ChatLog,
  Effect.gen(function* () {
    const chats = yield* Ref.make(new Map<ChatId, ReadonlyArray<AssistantEvent.Entry>>())

    return make({
      read: (chatId, options) =>
        Effect.map(Ref.get(chats), (all) =>
          (all.get(chatId) ?? []).filter((entry) => entry.seq > (options?.after ?? 0))
        ),
      lastSeq: (chatId) => Effect.map(Ref.get(chats), (all) => all.get(chatId)?.at(-1)?.seq ?? 0),
      write: (chatId, entries) =>
        Ref.update(chats, (all) => new Map(all).set(chatId, [...(all.get(chatId) ?? []), ...entries])),
      lastEntries: Effect.map(Ref.get(chats), (all) => [...all.values()].flatMap((entries) => entries.slice(-1)))
    })
  })
)

const EventJson = Schema.fromJsonString(Schema.Union([AssistantEvent.AssistantEvent, AssistantEvent.AppEvent]))

// Postgres returns BIGINT and DOUBLE PRECISION columns as strings; other databases as numbers.
const SqlNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])

const Row = Schema.Struct({ chat_id: ChatId, seq: SqlNumber, at: SqlNumber, event: EventJson })

const decodeLastSeq = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.NullOr(SqlNumber) })))

/**
 * Layer that stores chats in a SQL table, `chat_log`, and creates it if it
 * doesn't exist.
 *
 * **Details**
 *
 * One row per entry: `chat_id`, `seq`, `at`, and `event` as JSON, keyed by
 * `(chat_id, seq)`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSql: Layer.Layer<ChatLog, never, SqlClient.SqlClient> = Layer.effect(
  ChatLog,
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()

    yield* sql`
      CREATE TABLE IF NOT EXISTS chat_log (
        chat_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at DOUBLE PRECISION NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (chat_id, seq)
      )
    `.pipe(Effect.orDie)

    const toEntries = Effect.fn(function* (rows: ReadonlyArray<unknown>) {
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows)

      return decoded.map((row) =>
        AssistantEvent.Entry.make({ chatId: row.chat_id, seq: row.seq, at: row.at, event: row.event })
      )
    })

    const encodeEvent = Schema.encodeEffect(EventJson)

    return make({
      read: Effect.fn(function* (chatId: ChatId, options?: ReadOptions) {
        const rows = yield* sql`
          SELECT chat_id, seq, at, event FROM chat_log WHERE chat_id = ${chatId} AND seq > ${options?.after ?? 0} ORDER BY seq
        `

        return yield* toEntries(rows)
      }, Effect.orDie),
      lastSeq: Effect.fn(function* (chatId: ChatId) {
        const rows = yield* sql`
          SELECT MAX(seq) AS seq FROM chat_log WHERE chat_id = ${chatId}
        `.pipe(Effect.flatMap(decodeLastSeq))

        return rows[0]?.seq ?? 0
      }, Effect.orDie),
      write: Effect.fn(function* (chatId: ChatId, entries: ReadonlyArray<AssistantEvent.Entry>) {
        const rows = yield* Effect.forEach(entries, (entry) =>
          Effect.map(encodeEvent(entry.event), (event) => ({ chat_id: chatId, seq: entry.seq, at: entry.at, event }))
        )

        yield* sql`INSERT INTO chat_log ${sql.insert(rows)}`
      }, Effect.orDie),
      lastEntries: Effect.gen(function* () {
        const rows = yield* sql`
          SELECT e.chat_id, e.seq, e.at, e.event FROM chat_log e
          JOIN (SELECT chat_id, MAX(seq) AS seq FROM chat_log GROUP BY chat_id) last
            ON last.chat_id = e.chat_id AND last.seq = e.seq
        `

        return yield* toEntries(rows)
      }).pipe(Effect.orDie)
    })
  })
)
