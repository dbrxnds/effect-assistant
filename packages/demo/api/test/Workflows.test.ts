import { describe, expect, it } from "@effect/vitest"
import * as AssistantEngine from "effect-assistant/AssistantEngine"
import * as ChatId from "effect-assistant/ChatId"
import * as ChatLog from "effect-assistant/ChatLog"
import * as RunId from "effect-assistant/RunId"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine"
import * as TestRunner from "effect/cluster/TestRunner"
import * as LanguageModel from "effect/ai/LanguageModel"
import { AcmeAssistant } from "../src/AcmeAssistant.ts"
import * as Campaign from "../src/Campaign.ts"
import * as LiveOrders from "../src/LiveOrders.ts"
import * as PrintOrders from "../src/PrintOrders.ts"
import { Research } from "../src/Research.ts"
import { WorkflowStep } from "../src/WorkflowStep.ts"

// Demo steps take no time in tests.
process.env.DEMO_STEP_SECONDS = "0"

/**
 * Acme, registered with a handler that doesn't call the model: the tests
 * read what the workflows tell the chat, from its log. The research
 * specialist gets an empty handler.
 */
const quietAcme = AcmeAssistant.toLayer(() => Stream.empty).pipe(Layer.provide(Research.toLayer(() => Stream.empty)))

// The runner wants a model; nothing here calls it.
const model = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.die("Nothing here calls the model."),
    streamText: () => Stream.die("Nothing here calls the model.")
  })
)

const decodeStep = Schema.decodeUnknownOption(Schema.toCodecJson(WorkflowStep))

/** The steps the workflows reported to a chat so far. */
const stepsOf = (chatId: ChatId.ChatId) =>
  ChatLog.ChatLog.use((log) => log.read(chatId)).pipe(
    Effect.map((entries) => entries.flatMap(({ event }) => Option.toArray(decodeStep(event))))
  )

const layer = Layer.mergeAll(Campaign.layerWorkflow, PrintOrders.layerWorkflow).pipe(
  Layer.provideMerge(quietAcme),
  Layer.provideMerge(Layer.merge(AssistantEngine.layerCluster, ClusterWorkflowEngine.layer)),
  Layer.provide(model),
  Layer.provideMerge(ChatLog.layerMemory),
  Layer.provideMerge(TestRunner.layer),
  Layer.provideMerge(LiveOrders.layerMemory)
)

const waitFor = (chatId: ChatId.ChatId, status: string) =>
  stepsOf(chatId).pipe(
    Effect.map((all) => all.find((step) => step.status === status)),
    Effect.filterOrFail(Predicate.isNotUndefined, () => `no ${status} yet`),
    Effect.retry(Schedule.spaced("50 millis")),
    Effect.timeout("10 seconds")
  )

const startCampaign = (chatId: ChatId.ChatId) =>
  Effect.gen(function* () {
    yield* Campaign.CreateCampaign.execute(
      {
        runId: yield* RunId.make(),
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
  })

describe("CreateCampaign", () => {
  it.live("goes live and reports first results", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const chatId = yield* ChatId.make()
        yield* startCampaign(chatId)
        yield* waitFor(chatId, "first_results")

        expect((yield* stepsOf(chatId)).map((step) => step.status)).toEqual([
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
        const chatId = yield* ChatId.make()
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
            runId: yield* RunId.make(),
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

        expect((yield* stepsOf(chatId)).map((step) => step.status)).toEqual([
          "confirmed",
          "printing",
          "shipped",
          "delivered"
        ])
        expect(shipped.details.trackingNumber).toMatch(/^1Z/)
        expect(order?.status).toBe("delivered")
        expect(order?.trackingNumber).toBe(shipped.details.trackingNumber)
      }).pipe(Effect.provide(layer))
    })
  )

  it.live("goes on quietly when its chat is deleted: the chat takes none of its steps after that", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const chatId = yield* ChatId.make()
        const orders = yield* LiveOrders.LiveOrders
        yield* orders.put(
          LiveOrders.LiveOrder.make({
            reference: "ACM-TEST03",
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
            runId: yield* RunId.make(),
            chatId,
            reference: "ACM-TEST03",
            office: "Acme Amsterdam",
            productName: "Acme branded pens",
            quantity: 500
          },
          { discard: true }
        )

        yield* waitFor(chatId, "confirmed")
        yield* (yield* AcmeAssistant).delete(chatId)

        // The order still moves; the deleted chat just isn't told.
        yield* orders.get("ACM-TEST03").pipe(
          Effect.filterOrFail(
            (order) => order?.status === "delivered",
            () => "not delivered yet"
          ),
          Effect.retry(Schedule.spaced("50 millis")),
          Effect.timeout("10 seconds")
        )

        // The log stays, and nothing is stored after the delete.
        const log = yield* ChatLog.ChatLog.use((log) => log.read(chatId))
        const deletedAt = log.findIndex(({ event }) => Predicate.isTagged(event, "ChatDeleted"))

        expect(deletedAt).toBeGreaterThan(-1)
        expect(log.slice(deletedAt + 1)).toEqual([])
      }).pipe(Effect.provide(layer))
    })
  )
})
