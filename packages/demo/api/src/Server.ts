/**
 * HTTP for the demo: `/health`, Effect RPC over WebSocket at `/rpc`, and the
 * built web app.
 *
 * @since 0.1.0
 */
import { AcmeRpcs } from "@acme/demo-shared/Rpc"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import { createServer } from "node:http"
import { AcmeAssistant } from "./AcmeAssistant.ts"
import * as Chats from "./Chats.ts"
import * as LiveOrders from "./LiveOrders.ts"
import * as StaticSite from "./StaticSite.ts"

const layerRpcHandlers = AcmeRpcs.toLayer(
  Effect.gen(function* () {
    const acme = yield* AcmeAssistant
    const chats = yield* Chats.Chats
    const orders = yield* LiveOrders.LiveOrders

    return AcmeRpcs.of({
      Subscribe: ({ chatId }) => acme.subscribeView(chatId),
      Submit: ({ chatId, input }) =>
        (Predicate.isTagged(input, "UserMessage") ? chats.titleFromMessage(chatId, input.text) : Effect.void).pipe(
          Effect.andThen(acme.submit(chatId, input))
        ),
      ListChats: () => chats.list,
      CreateChat: () => chats.create.pipe(Effect.map((chat) => ({ chatId: chat.chatId }))),
      // A deleted chat takes its demo orders along, so budgets don't drift with every test run.
      DeleteChat: ({ chatId }) =>
        chats.delete(chatId).pipe(Effect.andThen(acme.delete(chatId)), Effect.andThen(orders.removeChat(chatId)))
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
