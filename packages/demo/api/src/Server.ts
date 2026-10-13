/**
 * HTTP for the demo: `/health`, Effect RPC over WebSocket at `/rpc`, and the
 * built web app.
 *
 * @since 0.1.0
 */
import { AcmeRpcs } from "@acme/demo-shared/Rpc"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as ChatView from "effect-assistant/ChatView"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine"
import { createServer } from "node:http"
import { AcmeAssistant } from "./AcmeAssistant.ts"
import * as Campaign from "./Campaign.ts"
import * as Chats from "./Chats.ts"
import * as LiveOrders from "./LiveOrders.ts"
import * as PrintOrders from "./PrintOrders.ts"
import * as StaticSite from "./StaticSite.ts"

const layerRpcHandlers = AcmeRpcs.toLayer(
  Effect.gen(function* () {
    const acme = yield* AcmeAssistant
    const chats = yield* Chats.Chats
    const orders = yield* LiveOrders.LiveOrders
    // The buttons on order and campaign blocks: they place what the block shows, and tell the chat.
    const placing = yield* Effect.context<LiveOrders.LiveOrders | WorkflowEngine.WorkflowEngine>()

    return AcmeRpcs.of({
      // No `show`: Acme's own events are for the model, so none reach the user.
      Subscribe: ({ chatId }) => acme.subscribe(chatId).pipe(ChatView.updates(AcmeAssistant)),
      Submit: ({ chatId, input }) =>
        (Predicate.isTagged(input, "UserMessage") ? chats.titleFromMessage(chatId, input.text) : Effect.void).pipe(
          Effect.andThen(acme.submit(chatId, input))
        ),
      ListChats: () => chats.list,
      CreateChat: () => chats.create.pipe(Effect.map((chat) => ({ chatId: chat.chatId }))),
      // A deleted chat takes its demo orders along, so budgets don't drift with every test run.
      DeleteChat: ({ chatId }) =>
        chats.delete(chatId).pipe(Effect.andThen(acme.delete(chatId)), Effect.andThen(orders.removeChat(chatId))),
      PlaceOrder: ({ chatId, messageId, order }) =>
        PrintOrders.place(chatId, messageId, order).pipe(
          Effect.provideService(AcmeAssistant, acme),
          Effect.provideContext(placing)
        ),
      StartCampaign: ({ chatId, messageId, campaign }) =>
        Campaign.start(chatId, messageId, campaign).pipe(
          Effect.provideService(AcmeAssistant, acme),
          Effect.provideContext(placing)
        )
    })
  })
)

const routes = Layer.mergeAll(
  HttpRouter.add("GET", "/health", HttpServerResponse.json({ ok: true })),
  RpcServer.layerHttp({ group: AcmeRpcs, path: "/rpc", protocol: "websocket" }).pipe(
    Layer.provide(layerRpcHandlers),
    Layer.provide(RpcSerialization.layerNdjson)
  ),
  StaticSite.layer
)

/**
 * Layer that serves HTTP on `PORT` (the host sets it; local dev uses 8787).
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(8787))

    return HttpRouter.serve(routes).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port, host: "0.0.0.0" })))
  })
)
