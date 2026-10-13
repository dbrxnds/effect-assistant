/**
 * The RPCs between the browser and the API, over one WebSocket per tab at
 * `/rpc`.
 *
 * `Subscribe` streams a chat as its user sees it (its `Timeline`): its messages
 * and their blocks, the orders and campaigns waiting for the user's approval,
 * and whether Acme or a specialist is working. The web app folds the changes
 * and renders them; it never gets the assistant's own work (model output, tool
 * results, workflow steps).
 *
 * `Submit` takes what the user does: a message, a block's answer, or a
 * decision on a call waiting for approval.
 *
 * @since 0.1.0
 */
import * as AssistantEvent from "effect-assistant/AssistantEvent"
import * as Chats from "effect-assistant/Chats"
import * as ChatId from "effect-assistant/ChatId"
import * as Timeline from "effect-assistant/Timeline"
import * as Schema from "effect/Schema"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import { ChatList } from "./ChatList.ts"

/**
 * Streams a chat's timeline: what changed, from the start, then live.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const Subscribe = Rpc.make("Subscribe", {
  payload: { chatId: ChatId.ChatId },
  // None of Acme's own events. Its calls waiting for the user's approval are always in it.
  success: Timeline.Change(),
  stream: true
})

/**
 * Sends what the user did: typed text (`UserMessage`), a block they used
 * (`BlockAnswer`), or a decision on a call (`ApprovalDecision`). Each has an
 * id (the client mints a message's), so a retried send is stored once.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const Submit = Rpc.make("Submit", {
  payload: { chatId: ChatId.ChatId, input: AssistantEvent.UserInput },
  error: Chats.GetChatError
})

/**
 * Lists the threads.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const ListChats = Rpc.make("ListChats", { success: ChatList })

/**
 * Creates a thread.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const CreateChat = Rpc.make("CreateChat", {
  success: Schema.Struct({ chatId: ChatId.ChatId })
})

/**
 * Deletes a thread and its chat. The seeded thread can't be deleted.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const DeleteChat = Rpc.make("DeleteChat", {
  payload: { chatId: ChatId.ChatId },
  error: Schema.Literals(["unknown_chat", "protected_chat"])
})

/**
 * Every RPC the API serves.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const AcmeRpcs = RpcGroup.make(Subscribe, Submit, ListChats, CreateChat, DeleteChat)
