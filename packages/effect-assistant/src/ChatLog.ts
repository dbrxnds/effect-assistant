/**
 * The `ChatLog` module stores each chat as an append-only list of
 * `AssistantEvent`s.
 *
 * It's the storage: `append` numbers entries after the chat's last `seq`,
 * and `read` returns them in order. The engine's chats write through it one
 * at a time (each chat has a lock) and send new entries to the chat's
 * subscribers; an assistant's `subscribe` streams them. One process writes
 * each chat: the cluster engine sends a chat to one entity.
 *
 * @since 0.1.0
 */
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
export class ChatLog extends Context.Service<ChatLog, {
  /** Appends events to a chat and returns them as stored entries. */
  readonly append: (
    chatId: ChatId,
    events: ReadonlyArray<AssistantEvent.AssistantEvent>
  ) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
  /** Reads every stored entry of a chat, in order. */
  readonly read: (chatId: ChatId) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
  /** Chats whose last entry doesn't end a turn: the ones that may still owe one, after a restart. */
  readonly unfinished: Effect.Effect<ReadonlyArray<ChatId>>
}>()("effect-assistant/ChatLog") {}

/**
 * The storage a `ChatLog` is built on: read a chat, find its last `seq`,
 * write new entries, and find every chat's last entry.
 *
 * @category models
 * @since 0.1.0
 */
export interface Storage {
  readonly read: (chatId: ChatId) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
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
    append: Effect.fn(function*(chatId: ChatId, events: ReadonlyArray<AssistantEvent.AssistantEvent>) {
      if (events.length === 0) return []

      const seq = yield* storage.lastSeq(chatId)
      const at = Date.now()
      const entries = events.map((event, n) => AssistantEvent.Entry.make({ chatId, seq: seq + n + 1, at, event }))
      yield* storage.write(chatId, entries)

      return entries
    }),
    unfinished: storage.lastEntries.pipe(
      Effect.map((last) => last.flatMap((entry) => AssistantEvent.isTurnEnd(entry.event) ? [] : [entry.chatId]))
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
  Effect.gen(function*() {
    const chats = yield* Ref.make(new Map<ChatId, ReadonlyArray<AssistantEvent.Entry>>())

    return make({
      read: (chatId) => Ref.get(chats).pipe(Effect.map((all) => all.get(chatId) ?? [])),
      lastSeq: (chatId) => Ref.get(chats).pipe(Effect.map((all) => all.get(chatId)?.at(-1)?.seq ?? 0)),
      write: (chatId, entries) =>
        Ref.update(chats, (all) => new Map(all).set(chatId, [...(all.get(chatId) ?? []), ...entries])),
      lastEntries: Ref.get(chats).pipe(Effect.map((all) => [...all.values()].flatMap((entries) => entries.slice(-1))))
    })
  })
)

const EventJson = Schema.fromJsonString(AssistantEvent.AssistantEvent)

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
  Effect.gen(function*() {
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

    const decode = Schema.decodeUnknownEffect(EventJson)
    const encode = Schema.encodeEffect(EventJson)
    const decodeChatId = Schema.decodeUnknownEffect(ChatId)

    return make({
      read: (chatId) =>
        // Postgres returns BIGINT and DOUBLE PRECISION columns as strings.
        sql<{ readonly seq: string | number; readonly at: string | number; readonly event: string }>`
          SELECT seq, at, event FROM chat_log WHERE chat_id = ${chatId} ORDER BY seq
        `.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decode(row.event).pipe(
                Effect.map((event) =>
                  AssistantEvent.Entry.make({ chatId, seq: Number(row.seq), at: Number(row.at), event })
                )
              ))
          ),
          Effect.orDie
        ),
      lastSeq: (chatId) =>
        sql<
          { readonly seq: string | number | null }
        >`SELECT MAX(seq) AS seq FROM chat_log WHERE chat_id = ${chatId}`
          .pipe(
            Effect.map((rows) => Number(rows[0]?.seq ?? 0)),
            Effect.orDie
          ),
      write: (chatId, entries) =>
        Effect.forEach(entries, (entry) =>
          encode(entry.event).pipe(
            Effect.map((event) => ({ chat_id: chatId, seq: entry.seq, at: entry.at, event }))
          )).pipe(
            Effect.flatMap((rows) => sql`INSERT INTO chat_log ${sql.insert(rows)}`),
            Effect.asVoid,
            Effect.orDie
          ),
      lastEntries: sql<
        {
          readonly chat_id: string
          readonly seq: string | number
          readonly at: string | number
          readonly event: string
        }
      >`
        SELECT e.chat_id, e.seq, e.at, e.event FROM chat_log e
        JOIN (SELECT chat_id, MAX(seq) AS seq FROM chat_log GROUP BY chat_id) last
          ON last.chat_id = e.chat_id AND last.seq = e.seq
      `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row) =>
              Effect.all({ chatId: decodeChatId(row.chat_id), event: decode(row.event) }).pipe(
                Effect.map(({ chatId, event }) =>
                  AssistantEvent.Entry.make({ chatId, seq: Number(row.seq), at: Number(row.at), event })
                )
              )
          )
        ),
        Effect.orDie
      )
    })
  })
)
