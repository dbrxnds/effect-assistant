/**
 * The browser side of `AcmeRpcs`: one NDJSON WebSocket per tab at `/rpc`.
 *
 * - {@link AcmeRpc} owns the socket. Mount `AcmeRpc.runtime` once at the page root.
 * - {@link connectionAtom} reflects the socket.
 * - {@link chatSessionAtom} is one `Subscribe` per open chat, retried when it drops.
 */
import { type ChatList, seededChat } from "@acme/demo-shared/ChatList"
import { AcmeRpcs } from "@acme/demo-shared/Rpc"
import type * as ChatId from "effect-assistant/ChatId"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import * as Atom from "effect/reactivity/Atom"
import * as AtomRpc from "effect/reactivity/AtomRpc"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Socket from "effect/socket/Socket"
import * as ChatState from "./ChatState.ts"

const socketUrl = () => `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/rpc`

/** Whether the socket is up. */
export const connectionAtom = Atom.keepAlive(Atom.make<"connecting" | "open" | "closed">("connecting"))

const layerConnectionHooks = (get: Atom.AtomContext) =>
  Layer.succeed(RpcClient.ConnectionHooks, {
    onConnect: Effect.sync(() => get.registry.set(connectionAtom, "open")),
    onDisconnect: Effect.sync(() => get.registry.set(connectionAtom, "closed"))
  })

/** The RPC client, as atoms. */
export class AcmeRpc extends AtomRpc.Service<AcmeRpc>()("AcmeRpc", {
  group: AcmeRpcs,
  protocol: (get) =>
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(socketUrl())),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(layerConnectionHooks(get))
    )
}) {}

/** A chat's state from its `Subscribe` stream of view updates. Resubscribes every 2s after it drops. */
export const chatSessionAtom = Atom.family((chatId: ChatId.ChatId) =>
  AcmeRpc.runtime.atom(
    Stream.unwrap(
      Effect.map(AcmeRpc, (client) =>
        Stream.suspend(() => client("Subscribe", { chatId })).pipe(
          Stream.catchCause(() => Stream.empty),
          Stream.repeat(Schedule.spaced("2 seconds"))
        )
      )
    ).pipe(Stream.scan(() => ChatState.initial, ChatState.apply)),
    { initialValue: ChatState.initial }
  )
)

/** A chat's state, or its initial state while loading. */
export const chatSession = (result: AsyncResult.AsyncResult<ChatState.ChatState, unknown>) =>
  AsyncResult.getOrElse(result, () => ChatState.initial)

/** Refreshes the thread list after a mutation. */
export const chatListKeys = ["chats"]

export const chatListAtom = AcmeRpc.query("ListChats", undefined, { reactivityKeys: chatListKeys })

/** The thread list, or just the seeded thread while loading. */
export const chatList = (result: AsyncResult.AsyncResult<ChatList, unknown>): ChatList =>
  AsyncResult.getOrElse(result, () => [seededChat])

export const createChat = AcmeRpc.mutation("CreateChat")

export const deleteChat = AcmeRpc.mutation("DeleteChat")

export const submit = AcmeRpc.mutation("Submit")

/** The buttons on order and campaign blocks: the API places what the block shows, and tells the chat. */
export const placeOrder = AcmeRpc.mutation("PlaceOrder")

export const startCampaign = AcmeRpc.mutation("StartCampaign")
