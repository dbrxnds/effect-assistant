/**
 * The RPCs between the browser and the API, over one WebSocket per tab at
 * `/rpc`.
 *
 * `Subscribe` streams a chat as its user sees it (`ChatView`): its messages
 * and their blocks, and whether Acme or a specialist is working. The web app
 * folds the updates and renders them; it never gets the assistant's own work
 * (model output, tool calls, workflow steps).
 *
 * @since 0.1.0
 */
import * as AssistantEvent from "effect-assistant/AssistantEvent"
import * as ChatId from "effect-assistant/ChatId"
import * as ChatView from "effect-assistant/ChatView"
import * as Schema from "effect/Schema"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import { ChatList } from "./ChatList.ts"

/**
 * Streams a chat's view: what changed, from the start, then live.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const Subscribe = Rpc.make("Subscribe", {
  payload: { chatId: ChatId.ChatId },
  success: ChatView.Update,
  stream: true
})

/**
 * Sends what the user did: typed text (`UserMessage`) or a block they used
 * (`BlockAnswer`). The client mints `input.id`, so a retried send is stored
 * once.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const Submit = Rpc.make("Submit", {
  payload: { chatId: ChatId.ChatId, input: AssistantEvent.UserInput }
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
