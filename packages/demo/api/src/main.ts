/**
 * The demo process: HTTP and RPC, the Acme assistant on the cluster engine
 * (one entity per chat), and the campaign and print workflows. On Postgres when `DATABASE_URL` is set,
 * in memory otherwise. Every setting is read with `Config` in the layer that
 * uses it, so a missing one (like `ANTHROPIC_API_KEY`) stops the process with
 * a `ConfigError` that names it.
 *
 * @since 0.1.0
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as AssistantEngine from "effect-assistant/AssistantEngine"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine"
import * as Acme from "./Acme.ts"
import * as Campaign from "./Campaign.ts"
import * as Observability from "./Observability.ts"
import * as PrintOrders from "./PrintOrders.ts"
import * as Prompts from "./Prompts.ts"
import * as Server from "./Server.ts"
import * as Storage from "./Storage.ts"

const layerApp = Server.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Campaign.layerWorkflow, PrintOrders.layerWorkflow)),
  Layer.provideMerge(Acme.layer),
  Layer.provideMerge(Layer.merge(AssistantEngine.layerCluster, ClusterWorkflowEngine.layer)),
  Layer.provide([Acme.layerModel, Prompts.layer]),
  Layer.provideMerge(Storage.layer),
  Layer.provide(Observability.layer)
)

Layer.launch(layerApp).pipe(Effect.tapCause((cause) => Effect.logError(cause)), NodeRuntime.runMain)
