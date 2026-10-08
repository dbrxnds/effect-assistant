/**
 * This module provides the `Chats` service, through which the app tells the library which chats
 * exist.
 *
 * The app keeps its own record of each chat (its owner, its title, whether it was deleted) and
 * decides when a chat is created: up front, or on its first message. The library asks `Chats`
 * before it stores an input and before each model call. When the app reports a chat as deleted,
 * the library deletes it as well (see `Assistant.delete`).
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ChatId } from "./ChatId.ts"

/**
 * Schema for the reason a chat can't be used. `"NotFound"` means the app doesn't know the chat,
 * and `"Deleted"` means the app deleted it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Reason = Schema.Literals(["NotFound", "Deleted"])

/**
 * The reason a chat can't be used.
 *
 * @category models
 * @since 0.1.0
 */
export type Reason = typeof Reason.Type

/**
 * Represents the error that `get` fails with when a chat can't be used. It carries the chat's id
 * and the {@link Reason}. An input for such a chat isn't stored.
 *
 * **Example** (Failing for an unknown chat)
 *
 * ```ts
 * if (row === undefined) return yield* new GetChatError({ chatId, reason: "NotFound" })
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class GetChatError extends Schema.TaggedError<GetChatError>()("GetChatError", {
  chatId: ChatId,
  reason: Reason
}) {}

/**
 * Represents what the library needs to know about a chat, which is its id. The app's own record
 * can carry more.
 *
 * @category models
 * @since 0.1.0
 */
export interface Chat {
  readonly chatId: ChatId
}

/**
 * Represents the app's chats, as the `Chats` service exposes them.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /** Returns the chat, or fails with a `GetChatError` that says why it can't be used. */
  readonly get: (chatId: ChatId) => Effect.Effect<Chat, GetChatError>
}

/**
 * Service that tells the library which of the app's chats exist.
 *
 * **Details**
 *
 * By default every chat exists from its first input, and a chat is deleted only when its log
 * says so (`ChatDeleted`). Provide your own implementation to have the app decide. Provide it
 * where you provide the `ChatLog`, so the engine and your server see the same one.
 *
 * **Example** (Reading chats from the app's own table)
 *
 * ```ts
 * import { type ChatId, Chats } from "effect-assistant"
 * import * as Effect from "effect/Effect"
 * import * as Layer from "effect/Layer"
 * import * as SqlClient from "effect/sql/SqlClient"
 *
 * const ChatsLive = Layer.effect(
 *   Chats.Chats,
 *   Effect.gen(function* () {
 *     const sql = yield* SqlClient.SqlClient
 *
 *     return {
 *       get: Effect.fn(function* (chatId: ChatId.ChatId) {
 *         const [row] = yield* sql<{ readonly deleted_at: number | null }>`
 *           SELECT deleted_at FROM chats WHERE chat_id = ${chatId}
 *         `.pipe(Effect.orDie)
 *
 *         if (row === undefined) {
 *           return yield* new Chats.GetChatError({ chatId, reason: "NotFound" })
 *         }
 *         if (row.deleted_at !== null) {
 *           return yield* new Chats.GetChatError({ chatId, reason: "Deleted" })
 *         }
 *
 *         return { chatId }
 *       })
 *     }
 *   })
 * )
 * ```
 *
 * @category services
 * @since 0.1.0
 */
export const Chats: Context.Reference<Service> = Context.Reference<Service>("effect-assistant/Chats", {
  defaultValue: () => ({ get: (chatId) => Effect.succeed({ chatId }) })
})
