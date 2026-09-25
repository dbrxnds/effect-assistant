import * as Anthropic from "@effect-uai/anthropic/Anthropic"
import { describe, expect, it } from "@effect/vitest"
import * as AssistantEngine from "effect-assistant/AssistantEngine"
import * as AssistantEvent from "effect-assistant/AssistantEvent"
import * as ChatId from "effect-assistant/ChatId"
import * as ChatLog from "effect-assistant/ChatLog"
import * as RunId from "effect-assistant/RunId"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine"
import * as TestRunner from "effect/unstable/cluster/TestRunner"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred"
import { AcmeAssistant } from "../src/AcmeAssistant.ts"
import * as Campaign from "../src/Campaign.ts"
import * as LiveOrders from "../src/LiveOrders.ts"
import * as PrintOrders from "../src/PrintOrders.ts"
import { Research } from "../src/Research.ts"

// Demo steps take no time in tests.
process.env.DEMO_STEP_SECONDS = "0"

/**
 * Acme, registered with a handler that doesn't call the model: the tests
 * only read what the workflows tell the chat, from its log. The research
 * specialist gets an empty handler too.
 */
const quietAcme = AcmeAssistant.toLayer(() => Stream.empty).pipe(Layer.provide(Research.toLayer(() => Stream.empty)))

// The runner wants a model API; nothing here calls it.
const anthropic = Anthropic.layer({ apiKey: Redacted.make(process.env.ANTHROPIC_API_KEY ?? "") }).pipe(
  Layer.provide(FetchHttpClient.layer)
)

/** The inputs stored in a chat so far. */
const inputsOf = (chatId: ChatId.ChatId) =>
  ChatLog.ChatLog.use((log) => log.read(chatId)).pipe(
    Effect.map((entries) => entries.flatMap(({ event }) => (AssistantEvent.isInput(event) ? [event] : [])))
  )

const Step = Schema.Struct({
  status: Schema.String,
  approvalToken: Schema.optional(DurableDeferred.Token),
  trackingNumber: Schema.optional(Schema.String)
})

const steps = (inputs: ReadonlyArray<AssistantEvent.Input>) =>
  inputs.flatMap((input) =>
    Predicate.isTagged(input, "Fact") ? Option.toArray(Schema.decodeUnknownOption(Step)(input.payload)) : []
  )

const layer = Layer.mergeAll(Campaign.layerWorkflow, PrintOrders.layerWorkflow).pipe(
  Layer.provideMerge(quietAcme),
  Layer.provideMerge(Layer.merge(AssistantEngine.layerCluster, ClusterWorkflowEngine.layer)),
  Layer.provide(anthropic),
  Layer.provideMerge(ChatLog.layerMemory),
  Layer.provideMerge(TestRunner.layer),
  Layer.provideMerge(LiveOrders.layerMemory)
)

const waitFor = (chatId: ChatId.ChatId, status: string) =>
  inputsOf(chatId).pipe(
    Effect.map((all) => steps(all).find((step) => step.status === status)),
    Effect.filterOrFail(Predicate.isNotUndefined, () => `no ${status} yet`),
    Effect.retry(Schedule.spaced("50 millis")),
    Effect.timeout("10 seconds")
  )

describe("CreateCampaign", () => {
  it.live("waits for approval, then goes live and reports first results", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const chatId = ChatId.make()
        yield* Campaign.CreateCampaign.execute(
          {
            runId: RunId.make(),
            chatId,
            reference: "ACM-TEST01",
            campaignName: "Summer Campaign",
            office: "Acme Amsterdam",
            audience: "parents in Austin",
            budget: 6000,
            channels: ["social", "display"]
          },
          { discard: true }
        )

        const parked = yield* waitFor(chatId, "awaiting_approval")
        yield* Campaign.decideApproval(parked.approvalToken!, "approve")
        yield* waitFor(chatId, "first_results")

        expect(steps(yield* inputsOf(chatId)).map((step) => step.status)).toEqual([
          "awaiting_approval",
          "creative_in_progress",
          "scheduled",
          "live",
          "first_results"
        ])
      }).pipe(Effect.provide(layer))
    })
  )
})

describe("PrintOrder", () => {
  it.live("reports confirmed, printing, shipped with tracking, and delivered, and updates the order", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const chatId = ChatId.make()
        const orders = yield* LiveOrders.LiveOrders
        yield* orders.put(
          LiveOrders.LiveOrder.make({
            reference: "ACM-TEST02",
            kind: "product",
            office: "Acme Amsterdam",
            locationId: "location:amsterdam",
            description: "500 × Acme branded pens",
            total: 450,
            status: "placed",
            placedOn: "2026-09-24",
            updatedAt: 0
          })
        )
        yield* PrintOrders.PrintOrder.execute(
          {
            runId: RunId.make(),
            chatId,
            reference: "ACM-TEST02",
            office: "Acme Amsterdam",
            productName: "Acme branded pens",
            quantity: 500
          },
          { discard: true }
        )

        const shipped = yield* waitFor(chatId, "shipped")
        yield* waitFor(chatId, "delivered")
        const order = yield* orders.get("ACM-TEST02")

        expect(steps(yield* inputsOf(chatId)).map((step) => step.status)).toEqual([
          "confirmed",
          "printing",
          "shipped",
          "delivered"
        ])
        expect(shipped.trackingNumber).toMatch(/^1Z/)
        expect(order?.status).toBe("delivered")
        expect(order?.trackingNumber).toBe(shipped.trackingNumber)
      }).pipe(Effect.provide(layer))
    })
  )
})
