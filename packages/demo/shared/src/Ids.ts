/**
 * Ids shared by the web app and the API.
 *
 * @since 0.1.0
 */
import * as ChatId from "effect-assistant/ChatId"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * The seeded "Campaigns" thread.
 *
 * @category constants
 * @since 0.1.0
 */
export const demoChatId = ChatId.ChatId.make("chat:00000000-0000-4000-8000-000000000001")

/**
 * Reads a chat id from a route parameter, or returns `undefined`.
 *
 * @category decoding
 * @since 0.1.0
 */
export const readChatId = (raw: string | undefined): ChatId.ChatId | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ChatId.ChatId)(raw))
