/**
 * The thread list shown in the sidebar.
 *
 * @since 0.1.0
 */
import * as ChatId from "effect-assistant/ChatId"
import * as Schema from "effect/Schema"
import { demoChatId } from "./Ids.ts"

/**
 * The title of a thread before its first message.
 *
 * @category constants
 * @since 0.1.0
 */
export const newChatTitle = "New thread"

/**
 * What an empty thread says.
 *
 * @category constants
 * @since 0.1.0
 */
export const emptyThreadPrompt =
  "Order campaigns and branded products, track orders, check budgets, look up an office, or ask for a report."

/**
 * Things to try in an empty thread, one click each.
 *
 * @category constants
 * @since 0.1.0
 */
export const suggestions: ReadonlyArray<string> = [
  "Order 300 cotton tote bags for the Berlin office",
  "How much budget does Amsterdam have left this quarter?",
  "I want to run a campaign for the London office",
  "Have research compare this year's campaigns and suggest Q4 budgets",
  "Where's the New York tote bag order?"
]

/**
 * One thread in the list.
 *
 * @category models
 * @since 0.1.0
 */
export class ChatSummary extends Schema.Class<ChatSummary>("acme/ChatSummary")({
  chatId: ChatId.ChatId,
  title: Schema.String,
  /** Epoch milliseconds. */
  createdAt: Schema.Finite
}) {}

/**
 * Schema for the thread list.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ChatList = Schema.Array(ChatSummary)

/**
 * The thread list.
 *
 * @category models
 * @since 0.1.0
 */
export type ChatList = typeof ChatList.Type

/**
 * The seeded thread. It can't be deleted.
 *
 * @category constants
 * @since 0.1.0
 */
export const seededChat = ChatSummary.make({ chatId: demoChatId, title: "Campaigns", createdAt: 0 })

const titleLimit = 42

/**
 * Returns a thread title from its first message.
 *
 * @category constructors
 * @since 0.1.0
 */
export const titleFromText = (text: string): string => {
  const flat = text.trim().replaceAll(/\s+/g, " ")

  if (flat.length === 0) return newChatTitle

  return flat.length <= titleLimit ? flat : `${flat.slice(0, titleLimit - 1)}…`
}

/**
 * Sorts threads newest first; the seeded thread, created at 0, comes last.
 *
 * @category ordering
 * @since 0.1.0
 */
export const sortChats = (chats: ReadonlyArray<ChatSummary>): ReadonlyArray<ChatSummary> =>
  [...chats].sort((a, b) => b.createdAt - a.createdAt)
