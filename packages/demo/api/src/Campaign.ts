/**
 * Ordering a campaign.
 *
 * The assistant collects the audience and budget in chat, then calls
 * `start_campaign`. That starts the `CreateCampaign` workflow, which first
 * asks for the user's decision on the order (`Decision.durable`: the
 * assistant asks with a decision block, and the workflow waits for the
 * answer), then reports each stage as a fact from `workflow:CreateCampaign`:
 *
 * 1. `declined`, if the user declined: the order is cancelled;
 * 2. `creative_in_progress`, then `scheduled`;
 * 3. `live`;
 * 4. `first_results`: early numbers, a few steps after going live.
 *
 * @since 0.1.0
 */
import * as Budgets from "@acme/demo-shared/Budgets"
import * as Locations from "@acme/demo-shared/Locations"
import * as Orders from "@acme/demo-shared/Orders"
import * as AssistantToolCall from "effect-assistant/AssistantToolCall"
import * as AssistantChat from "effect-assistant/AssistantChat"
import * as ChatId from "effect-assistant/ChatId"
import * as Decision from "effect-assistant/Decision"
import * as RunId from "effect-assistant/RunId"
import * as ToolFailure from "effect-assistant/ToolFailure"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as Workflow from "effect/unstable/workflow/Workflow"
import type * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { AcmeAssistant } from "./AcmeAssistant.ts"
import * as LiveOrders from "./LiveOrders.ts"
import * as PrintOrders from "./PrintOrders.ts"
import * as Steps from "./Steps.ts"

class CampaignProduct extends Schema.Class<CampaignProduct>("acme/CampaignProduct")({
  campaignId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  channels: Schema.Array(Orders.Channel),
  /** In USD. */
  minimumBudget: Schema.Finite
}) {}

const campaignProducts: ReadonlyArray<CampaignProduct> = [
  CampaignProduct.make({
    campaignId: "summer-flight",
    name: "Summer Campaign",
    description: "Warm-weather social and display flight, for families planning summer travel.",
    channels: ["social", "display"],
    minimumBudget: 2000
  }),
  CampaignProduct.make({
    campaignId: "summer-sale",
    name: "Summer Sale",
    description: "Short paid social push for warm-weather discounts.",
    channels: ["social"],
    minimumBudget: 1000
  }),
  CampaignProduct.make({
    campaignId: "back-to-school",
    name: "Back to School",
    description: "Search and social for families shopping for the new school year.",
    channels: ["social", "search"],
    minimumBudget: 1500
  }),
  CampaignProduct.make({
    campaignId: "holiday-gifting",
    name: "Holiday Gifting",
    description: "Search, social, and display for gift shoppers in November and December.",
    channels: ["search", "social", "display"],
    minimumBudget: 3000
  }),
  CampaignProduct.make({
    campaignId: "city-launch",
    name: "City Launch (out-of-home)",
    description: "Transit and bus-shelter posters plus display, for launches in a city.",
    channels: ["out_of_home", "display"],
    minimumBudget: 4000
  }),
  CampaignProduct.make({
    campaignId: "winter-clearance",
    name: "Winter Clearance",
    description: "January display clearance for leftover winter stock.",
    channels: ["display"],
    minimumBudget: 1000
  })
]

class CampaignFailed extends Schema.TaggedError<CampaignFailed>()("CampaignFailed", {
  reason: Schema.String
}) {}

/**
 * The workflow that runs a campaign order.
 *
 * @category workflows
 * @since 0.1.0
 */
export const CreateCampaign = Workflow.make("CreateCampaign", {
  payload: {
    runId: RunId.RunId,
    chatId: ChatId.ChatId,
    reference: Schema.String,
    campaignName: Schema.String,
    office: Schema.String,
    audience: Schema.String,
    budget: Schema.Finite,
    channels: Schema.Array(Orders.Channel)
  },
  success: Schema.Struct({ reference: Schema.String }),
  error: CampaignFailed,
  idempotencyKey: ({ runId }) => runId
})

type Payload = typeof CreateCampaign.payloadSchema.Type

const step = (payload: Payload, status: string, details: Steps.Step["details"] = {}) =>
  Effect.gen(function* () {
    yield* Steps.report({
      source: "workflow:CreateCampaign",
      runId: payload.runId,
      chatId: payload.chatId,
      status,
      details: { reference: payload.reference, campaign: payload.campaignName, office: payload.office, ...details }
    })
    yield* LiveOrders.setStatus(payload.reference, status)
  })

/** Early numbers a few days in: about a fifth of the budget, spread over the channels. */
const firstResults = (payload: Payload) => {
  const spend = Math.round(payload.budget * 0.2)
  const impressions = Math.round(spend * 150 * (0.9 + (payload.audience.length % 7) / 20))
  const clicks = Math.round(impressions * (payload.channels.includes("search") ? 0.021 : 0.009))
  const conversions = Math.max(1, Math.round(clicks * 0.035))

  return {
    spend,
    impressions,
    clicks,
    conversions,
    ctr: Math.round((clicks / impressions) * 10000) / 100,
    costPerConversion: Math.round((spend / conversions) * 100) / 100
  }
}

/**
 * Layer that registers the workflow.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWorkflow = CreateCampaign.toLayer(
  Effect.fn(function* (payload: Payload) {
    yield* LiveOrders.setStatus(payload.reference, "awaiting_approval")

    // The assistant asks the user, with a decision block; the workflow sleeps until they answer.
    const outcome = yield* Decision.durable(AcmeAssistant, {
      chatId: payload.chatId,
      name: "approval",
      source: "workflow:CreateCampaign",
      preview: {
        reference: payload.reference,
        campaign: payload.campaignName,
        office: payload.office,
        audience: payload.audience,
        budget: payload.budget,
        channels: payload.channels
      }
    })

    if (outcome === "declined") {
      yield* step(payload, "declined")

      return yield* CampaignFailed.make({ reason: "Declined" })
    }

    yield* step(payload, "creative_in_progress")
    yield* Steps.wait("Creative", 2)
    yield* step(payload, "scheduled", { channels: payload.channels.join(", ") })
    yield* Steps.wait("Scheduling", 1)
    yield* step(payload, "live")
    yield* Steps.wait("FirstResults", 3)
    yield* step(payload, "first_results", firstResults(payload))

    return { reference: payload.reference }
  })
)

/**
 * Lists the campaign products that can be ordered.
 *
 * @category tools
 * @since 0.1.0
 */
export const ListCampaignProducts = Tool.make("list_campaign_products", {
  description: "Campaign products that can be ordered, with their channels and minimum budget.",
  success: Schema.Array(CampaignProduct)
})

const CampaignStarted = Schema.Struct({
  runId: RunId.RunId,
  reference: Schema.String,
  status: Schema.Literal("started")
})

/**
 * Starts a campaign order.
 *
 * @category tools
 * @since 0.1.0
 */
export const StartCampaign = Tool.make("start_campaign", {
  description:
    "Order a campaign. Needs the product id, the office paying, who it should reach, and the budget in USD. Ask the user for anything missing first. Checks the office's budget; the run then asks for the user's decision (a <decision> request) and reports each stage back as a fact.",
  parameters: Schema.Struct({
    campaignId: Schema.String,
    office: Schema.String.annotate({ description: "The office paying for it, like Amsterdam." }),
    audience: Schema.String,
    budget: Schema.Finite.annotate({ description: "In USD." })
  }),
  success: Schema.Union([
    Schema.Struct({ reference: Schema.String, status: Schema.String, note: Schema.String }),
    CampaignStarted
  ]),
  failure: ToolFailure.ToolFailure,
  dependencies: [AssistantChat.AssistantChat, AssistantToolCall.AssistantToolCall]
})

/**
 * The campaign tools.
 *
 * @category toolkits
 * @since 0.1.0
 */
export const CampaignTools = Toolkit.make(ListCampaignProducts, StartCampaign)

/**
 * Layer for the campaign tools' handlers, on the orders placed through Acme
 * and the workflow engine.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerTools = CampaignTools.toLayer(
  Effect.gen(function* () {
    const services = yield* Effect.context<LiveOrders.LiveOrders | WorkflowEngine.WorkflowEngine>()

    return CampaignTools.of({
      list_campaign_products: () => Effect.succeed(campaignProducts),
      start_campaign: ({ campaignId, office, audience, budget }) =>
        Effect.gen(function* () {
          // The same run for every time this call runs: after a crash it runs again, and finds its order.
          const runId = RunId.fromKey(yield* AssistantToolCall.idempotencyKey)
          const reference = Steps.reference(runId)
          const orders = yield* LiveOrders.LiveOrders
          const placed = yield* orders.get(reference)

          if (placed !== undefined) return { reference, status: placed.status, note: "Already placed by this call." }

          const product = campaignProducts.find((candidate) => candidate.campaignId === campaignId)

          if (product === undefined) return yield* ToolFailure.fail(`Unknown campaignId ${campaignId}`)

          if (budget < product.minimumBudget) {
            return yield* ToolFailure.fail(`${product.name} needs at least $${product.minimumBudget}.`, {
              kind: "under_minimum"
            })
          }

          const location = Locations.findByName(office)

          if (location === undefined) return yield* ToolFailure.fail(`No office named ${office}.`)

          const officeBudget = yield* PrintOrders.officeBudget(location)

          if (budget > officeBudget.remaining) {
            return yield* ToolFailure.fail(
              `${location.name} has $${officeBudget.remaining} left in ${Budgets.currentQuarter.name}, less than $${budget}.`,
              { kind: "over_budget" }
            )
          }

          const chat = yield* AssistantChat.AssistantChat

          yield* orders.put(
            LiveOrders.LiveOrder.make({
              reference,
              chatId: chat.chatId,
              kind: "campaign",
              office: location.name,
              locationId: location.locationId,
              description: `${product.name} for ${audience}`,
              total: budget,
              status: "placed",
              placedOn: new Date().toISOString().slice(0, 10),
              updatedAt: Date.now()
            })
          )
          yield* CreateCampaign.execute(
            {
              runId,
              chatId: chat.chatId,
              reference,
              campaignName: product.name,
              office: location.name,
              audience,
              budget,
              channels: product.channels
            },
            { discard: true }
          )

          const started: typeof CampaignStarted.Type = { runId, reference, status: "started" }

          return started
        }).pipe(Effect.provideContext(services))
    })
  })
)
