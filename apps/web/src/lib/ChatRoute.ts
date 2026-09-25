/**
 * Chat URLs: `/chats/<chat id>`.
 */
import { readChatId } from "@acme/demo-shared/Ids"
import type * as ChatId from "effect-assistant/ChatId"
import * as Option from "effect/Option"

/** The path of a chat's page. */
export const path = (chatId: ChatId.ChatId): string => `/chats/${encodeURIComponent(chatId)}`

/** The chat id in a route parameter, if it is one. */
export const chatIdFromParam = (param: string): ChatId.ChatId | undefined =>
  Option.liftThrowable(decodeURIComponent)(param).pipe(Option.map(readChatId), Option.getOrUndefined)
