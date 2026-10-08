/**
 * The thread list. The seeded "Campaigns" thread always exists and can't be
 * deleted. A new thread takes its title from its first message.
 *
 * @since 0.1.0
 */
import { ChatSummary, newChatTitle, seededChat, sortChats, titleFromText } from "@acme/demo-shared/ChatList"
import * as ChatId from "effect-assistant/ChatId"
import * as ChatLog from "effect-assistant/ChatLog"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as SqlClient from "effect/sql/SqlClient"

type DeleteError = "unknown_chat" | "protected_chat"

/**
 * Service for the thread list.
 *
 * @category services
 * @since 0.1.0
 */
export class Chats extends Context.Service<
  Chats,
  {
    readonly list: Effect.Effect<ReadonlyArray<ChatSummary>>
    readonly create: Effect.Effect<ChatSummary>
    readonly delete: (chatId: ChatId.ChatId) => Effect.Effect<void, DeleteError>
    /** Names a new thread after its first message. */
    readonly titleFromMessage: (chatId: ChatId.ChatId, text: string) => Effect.Effect<void>
  }
>()("acme/Chats") {}

/**
 * Layer that keeps the thread list in memory.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory: Layer.Layer<Chats> = Layer.effect(
  Chats,
  Effect.gen(function* () {
    const store = yield* Ref.make(new Map<ChatId.ChatId, ChatSummary>([[seededChat.chatId, seededChat]]))

    return Chats.of({
      list: Ref.get(store).pipe(Effect.map((m) => sortChats([...m.values()]))),
      create: Effect.gen(function* () {
        const chat = ChatSummary.make({
          chatId: yield* ChatId.make,
          title: newChatTitle,
          createdAt: yield* Clock.currentTimeMillis
        })

        yield* Ref.update(store, (m) => new Map(m).set(chat.chatId, chat))

        return chat
      }),
      delete: Effect.fn(function* (chatId: ChatId.ChatId) {
        if (chatId === seededChat.chatId) return yield* Effect.fail("protected_chat" as const)

        const existed = yield* Ref.modify(store, (m) => {
          const next = new Map(m)

          return [next.delete(chatId), next]
        })

        if (!existed) return yield* Effect.fail("unknown_chat" as const)
      }),
      titleFromMessage: (chatId, text) =>
        Ref.update(store, (m) => {
          const chat = m.get(chatId)

          if (chat === undefined || chat.title !== newChatTitle) return m

          return new Map(m).set(chatId, ChatSummary.make({ ...chat, title: titleFromText(text) }))
        })
    })
  })
)

/**
 * Layer that keeps the thread list in a SQL table, `demo_chats`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSql: Layer.Layer<Chats, never, SqlClient.SqlClient> = Layer.effect(
  Chats,
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    yield* sql`
      CREATE TABLE IF NOT EXISTS demo_chats (
        chat_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at DOUBLE PRECISION NOT NULL
      )
    `

    const rows = sql<{ chat_id: ChatId.ChatId; title: string; created_at: number }>`
      SELECT chat_id, title, created_at FROM demo_chats
    `.pipe(
      Effect.map((rows) =>
        rows.map((r) => ChatSummary.make({ chatId: r.chat_id, title: r.title, createdAt: Number(r.created_at) }))
      )
    )

    return Chats.of({
      list: rows.pipe(
        Effect.map((chats) => sortChats([seededChat, ...chats])),
        Effect.orDie
      ),
      create: Effect.gen(function* () {
        const chat = ChatSummary.make({
          chatId: yield* ChatId.make,
          title: newChatTitle,
          createdAt: yield* Clock.currentTimeMillis
        })

        yield* sql`INSERT INTO demo_chats ${sql.insert({
          chat_id: chat.chatId,
          title: chat.title,
          created_at: chat.createdAt
        })}`

        return chat
      }).pipe(Effect.orDie),
      delete: Effect.fn(function* (chatId: ChatId.ChatId) {
        if (chatId === seededChat.chatId) return yield* Effect.fail("protected_chat" as const)

        const deleted = yield* sql<{ chat_id: string }>`
          DELETE FROM demo_chats WHERE chat_id = ${chatId} RETURNING chat_id
        `.pipe(Effect.orDie)

        if (deleted.length === 0) return yield* Effect.fail("unknown_chat" as const)
      }),
      titleFromMessage: (chatId, text) =>
        sql`
          UPDATE demo_chats SET title = ${titleFromText(text)}
          WHERE chat_id = ${chatId} AND title = ${newChatTitle}
        `.pipe(Effect.asVoid, Effect.orDie)
    })
  }).pipe(Effect.orDie)
)

/**
 * Layer for where the log records that a chat was deleted: its own table,
 * since a deleted thread's row in `demo_chats` is gone. The log refuses
 * writes to a chat recorded here.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerDeletedChats: Layer.Layer<ChatLog.DeletedChats, never, SqlClient.SqlClient> = Layer.effect(
  ChatLog.DeletedChats,
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    yield* sql`
      CREATE TABLE IF NOT EXISTS demo_deleted_chats (
        chat_id TEXT PRIMARY KEY,
        deleted_at DOUBLE PRECISION NOT NULL
      )
    `

    return ChatLog.DeletedChats.of({
      isDeleted: (chatId) =>
        sql`SELECT chat_id FROM demo_deleted_chats WHERE chat_id = ${chatId}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie
        ),
      markDeleted: (chatId, at) =>
        sql`
          INSERT INTO demo_deleted_chats (chat_id, deleted_at) VALUES (${chatId}, ${at})
          ON CONFLICT (chat_id) DO NOTHING
        `.pipe(Effect.asVoid, Effect.orDie)
    })
  }).pipe(Effect.orDie)
)
