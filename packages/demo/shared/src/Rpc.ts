/**
 * The RPCs between the browser and the API, over one WebSocket per tab at
 * `/rpc`.
 *
 * `Subscribe` streams a chat as its user sees it (`ChatView`): its messages
 * and their blocks, and whether Acme or a specialist is working. The web app
 * folds the updates and renders them; it never gets the assistant's own work
 * (model output, tool calls, workflow steps).
 *
 * `PlaceOrder` and `StartCampaign` are the buttons on an order or campaign
 * block: the user commits with exactly what the block shows, and the API
 * tells the chat, which wakes Acme to follow up.
 *
 * @since 0.1.0
 */
import * as AssistantEvent from "effect-assistant/AssistantEvent"
import * as Chats from "effect-assistant/Chats"
import * as ChatId from "effect-assistant/ChatId"
import * as ChatView from "effect-assistant/ChatView"
import * as Schema from "effect/Schema"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import { CampaignDraft, OrderDraft } from "./Blocks.ts"
import { ChatList } from "./ChatList.ts"

/**
 * Streams a chat's view: what changed, from the start, then live.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const Subscribe = Rpc.make("Subscribe", {
  payload: { chatId: ChatId.ChatId },
  // The view with none of Acme's own events: the server shows none.
  success: ChatView.Update(),
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
 * Why the API didn't place an order or start a campaign, for the user to
 * read, like an office that no longer has the budget.
 *
 * @category errors
 * @since 0.1.0
 */
export class OrderRefused extends Schema.Error<OrderRefused>("acme/OrderRefused")({
  _tag: Schema.tag("OrderRefused"),
  message: Schema.String
}) {}

/**
 * Places the product order an `order_draft` block shows. Once per block: a
 * second click returns the same reference.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const PlaceOrder = Rpc.make("PlaceOrder", {
  payload: { chatId: ChatId.ChatId, messageId: Schema.String, order: OrderDraft.props },
  success: Schema.Struct({ reference: Schema.String }),
  error: Schema.Union([OrderRefused, Chats.GetChatError])
})

/**
 * Starts the campaign a `campaign_draft` block shows. Once per block: a
 * second click returns the same reference.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const StartCampaign = Rpc.make("StartCampaign", {
  payload: { chatId: ChatId.ChatId, messageId: Schema.String, campaign: CampaignDraft.props },
  success: Schema.Struct({ reference: Schema.String }),
  error: Schema.Union([OrderRefused, Chats.GetChatError])
})

/**
 * Every RPC the API serves.
 *
 * @category rpcs
 * @since 0.1.0
 */
export const AcmeRpcs = RpcGroup.make(Subscribe, Submit, ListChats, CreateChat, DeleteChat, PlaceOrder, StartCampaign)
