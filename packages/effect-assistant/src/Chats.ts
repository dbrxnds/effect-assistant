/**
 * The `Chats` module is where the app says which chats exist. The app keeps
 * its chats (their owner, title, whether they were deleted) and decides when
 * one is created: up front, or on its first message. The library asks it
 * before it stores an input and before each model call, and a chat the app
 * says is deleted gets deleted here too (see `Assistant.delete`).
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ChatId } from "./ChatId.ts"

/** Why a chat can't be used: the app doesn't know it, or deleted it. */
export const Reason = Schema.Literals(["NotFound", "Deleted"])

/** Why a chat can't be used. */
export type Reason = typeof Reason.Type

/** The chat can't be used: an input for it isn't stored. */
export class ChatUnavailable extends Schema.TaggedError<ChatUnavailable>()("ChatUnavailable", {
  chatId: ChatId,
  reason: Reason
}) {}

/** What the library needs of a chat: its id. The app's own record can carry more. */
export interface Chat {
  readonly chatId: ChatId
}

/** Where the app's chats are. */
export interface Service {
  /** The chat, or why it can't be used. */
  readonly get: (chatId: ChatId) => Effect.Effect<Chat, ChatUnavailable>
}

/**
 * Service for the app's chats. By default every chat exists from its first
 * input, and a deleted one is one whose log says so (`ChatDeleted`): provide
 * your own to have the app decide.
 */
export const Chats: Context.Reference<Service> = Context.Reference<Service>("effect-assistant/Chats", {
  defaultValue: () => ({ get: (chatId) => Effect.succeed({ chatId }) })
})
