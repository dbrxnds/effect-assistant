/**
 * HTTP for the demo: `/health`, Effect RPC over WebSocket at `/rpc`, and the
 * built web app.
 *
 * @since 0.1.0
 */
import { AcmeRpcs } from "@acme/demo-shared/Rpc"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as AssistantEngine from "effect-assistant/AssistantEngine"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import { createServer } from "node:http"
import { AcmeAssistant } from "./AcmeAssistant.ts"
import * as Chats from "./Chats.ts"
import * as LiveOrders from "./LiveOrders.ts"
import * as StaticSite from "./StaticSite.ts"

const layerRpcHandlers = AcmeRpcs.toLayer(
  Effect.gen(function* () {
    const engine = yield* AssistantEngine.AssistantEngine
    const chats = yield* Chats.Chats
    const orders = yield* LiveOrders.LiveOrders

    return AcmeRpcs.of({
      Subscribe: ({ chatId }) =>
        AcmeAssistant.subscribe(chatId).pipe(Stream.provideService(AssistantEngine.AssistantEngine, engine)),
      Submit: ({ chatId, input }) =>
        (Predicate.isTagged(input, "UserMessage") ? chats.titleFromMessage(chatId, input.text) : Effect.void).pipe(
          Effect.andThen(AcmeAssistant.submit(chatId, input)),
          Effect.provideService(AssistantEngine.AssistantEngine, engine)
        ),
      ListChats: () => chats.list,
      CreateChat: () => chats.create.pipe(Effect.map((chat) => ({ chatId: chat.chatId }))),
      // A deleted chat takes its demo orders along, so budgets don't drift with every test run.
      DeleteChat: ({ chatId }) => chats.delete(chatId).pipe(Effect.andThen(orders.removeChat(chatId)))
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
