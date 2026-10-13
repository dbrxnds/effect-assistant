/**
 * Ordering a campaign.
 *
 * The assistant collects the audience and budget in chat, then shows the
 * campaign, office, audience, and budget in a `campaign_draft` block. Only the
 * user starts it, with the block's button: {@link start} checks the budget
 * again, starts the `CreateCampaign` workflow, and tells the chat. The
 * workflow reports each stage as a `WorkflowStep`:
 *
 * 1. `creative_in_progress`, then `scheduled`;
 * 2. `live`;
 * 3. `first_results`: early numbers, a few steps after going live.
 *
 * @since 0.1.0
 */
import type { CampaignDraft } from "@acme/demo-shared/Blocks"
import * as Budgets from "@acme/demo-shared/Budgets"
import * as Locations from "@acme/demo-shared/Locations"
import * as Orders from "@acme/demo-shared/Orders"
import { OrderRefused } from "@acme/demo-shared/Rpc"
import * as ChatId from "effect-assistant/ChatId"
import * as RunId from "effect-assistant/RunId"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Workflow from "effect/workflow/Workflow"
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
  idempotencyKey: ({ runId }) => runId
})

type Payload = typeof CreateCampaign.payloadSchema.Type

const step = (payload: Payload, status: string, details: Steps.Step["details"] = {}) =>
  Effect.gen(function* () {
    yield* Steps.report({
      workflow: "CreateCampaign",
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

/**
 * Whether a campaign order can go ahead, checked when the user starts it.
 * Fails for an unknown product or office, a budget under the product's
 * minimum, or one over the office's budget.
 */
const check = Effect.fn(function* ({ campaignId, office, audience, budget }: typeof CampaignDraft.props.Type) {
  const product = campaignProducts.find((candidate) => candidate.campaignId === campaignId)

  if (product === undefined) return yield* new OrderRefused({ message: `Unknown campaignId ${campaignId}` })

  if (budget < product.minimumBudget) {
    return yield* new OrderRefused({ message: `${product.name} needs at least $${product.minimumBudget}.` })
  }

  const location = Locations.findByName(office)

  if (location === undefined) return yield* new OrderRefused({ message: `No office named ${office}.` })

  const officeBudget = yield* PrintOrders.officeBudget(location)

  if (budget > officeBudget.remaining) {
    return yield* new OrderRefused({
      message: `${location.name} has $${officeBudget.remaining} left in ${Budgets.currentQuarter.name}, less than $${budget}.`
    })
  }

  return { product, location, audience, budget, remainingBudget: officeBudget.remaining - budget }
})

/**
 * The campaign tools.
 *
 * @category toolkits
 * @since 0.1.0
 */
export const CampaignTools = Toolkit.make(ListCampaignProducts)

/**
 * Layer for the campaign tools' handlers.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerTools = CampaignTools.toLayer({
  list_campaign_products: () => Effect.succeed(campaignProducts)
})

/**
 * Starts the campaign a `campaign_draft` block shows, when the user clicks
 * its button: it checks the budget again, starts the `CreateCampaign`
 * workflow, and tells the chat. Once per block: a second click finds the
 * first order.
 *
 * @category constructors
 * @since 0.1.0
 */
export const start = Effect.fn(function* (
  chatId: ChatId.ChatId,
  messageId: string,
  campaign: typeof CampaignDraft.props.Type
) {
  const runId = RunId.fromKey(`campaign:${chatId}:${messageId}`)
  const reference = Steps.reference(runId)
  const orders = yield* LiveOrders.LiveOrders
  const existing = yield* orders.get(reference)

  const placed =
    existing ??
    (yield* Effect.gen(function* () {
      // The budget may have moved since Acme showed the campaign.
      const { product, location, audience, budget } = yield* check(campaign)

      const placedNow = LiveOrders.LiveOrder.make({
        reference,
        chatId,
        kind: "campaign",
        office: location.name,
        locationId: location.locationId,
        description: `${product.name} for ${audience}`,
        total: budget,
        status: "placed",
        placedOn: new Date().toISOString().slice(0, 10),
        updatedAt: Date.now()
      })

      yield* orders.put(placedNow)
      yield* CreateCampaign.execute(
        {
          runId,
          chatId,
          reference,
          campaignName: product.name,
          office: location.name,
          audience,
          budget,
          channels: product.channels
        },
        { discard: true }
      )

      return placedNow
    }))

  yield* Steps.placed(chatId, messageId, placed)

  return { reference }
})
