/**
 * Acme's lookups (orders, offices, budgets, campaign results) and its
 * research specialist, backed by the demo data in `@acme/demo-shared` and
 * the orders placed through Acme.
 *
 * @since 0.1.0
 */
import * as Budgets from "@acme/demo-shared/Budgets"
import * as Locations from "@acme/demo-shared/Locations"
import * as Orders from "@acme/demo-shared/Orders"
import * as Performance from "@acme/demo-shared/Performance"
import * as AssistantLoop from "effect-assistant/AssistantLoop"
import * as ToolFailure from "effect-assistant/ToolFailure"
import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as LiveOrders from "./LiveOrders.ts"
import * as PrintOrders from "./PrintOrders.ts"
import * as Prompts from "./Prompts.ts"
import { Research } from "./Research.ts"

const OfficeInput = Schema.optional(Schema.String).annotate({ description: "Office name, like Amsterdam." })

/**
 * Lists recent orders, newest first: those placed through Acme, then the
 * order history.
 *
 * @category tools
 * @since 0.1.0
 */
export const OrderHistory = Tool.make("order_history", {
  description:
    "Recent product and campaign orders, newest first, including the ones placed through you. Optionally for one office or one kind.",
  parameters: Schema.Struct({
    office: OfficeInput,
    kind: Schema.optional(Schema.Literals(["product", "campaign"])),
    limit: Schema.optional(Schema.Int)
  }),
  success: Schema.Struct({
    placedThroughAcme: Schema.Array(LiveOrders.LiveOrder),
    history: Schema.Array(Orders.Order)
  }),
  failure: ToolFailure.ToolFailure
})

/**
 * Returns where an order is.
 *
 * @category tools
 * @since 0.1.0
 */
export const OrderStatus = Tool.make("order_status", {
  description: "Where one order is now: status, tracking, and what it contains.",
  parameters: Schema.Struct({
    order: Schema.String.annotate({ description: "An order reference like ACM-7K2Q9X, or an order id." })
  }),
  success: Schema.Union([LiveOrders.LiveOrder, Orders.Order]),
  failure: ToolFailure.ToolFailure
})

/**
 * Lists offices, or finds one by name.
 *
 * @category tools
 * @since 0.1.0
 */
export const Offices = Tool.make("offices", {
  description:
    "Acme offices: address, locale, contact, and default ship-to. Use for 'where is the X office', office addresses, or listing all offices. Pass a city or office name to get one; omit name to list all.",
  parameters: Schema.Struct({ name: OfficeInput }),
  success: Schema.Array(Locations.Location),
  failure: ToolFailure.ToolFailure
})

/**
 * Returns an office's marketing budget this quarter.
 *
 * @category tools
 * @since 0.1.0
 */
export const OfficeBudget = Tool.make("office_budget", {
  description:
    "An office's marketing budget this quarter: total, spent (including orders placed through you), and left.",
  parameters: Schema.Struct({ office: Schema.String.annotate({ description: "Office name, like Amsterdam." }) }),
  success: Budgets.OfficeBudget,
  failure: ToolFailure.ToolFailure
})

/**
 * Acme's lookups: orders, offices, and budgets.
 *
 * @category toolkits
 * @since 0.1.0
 */
export const LookupTools = Toolkit.make(OrderHistory, OrderStatus, Offices, OfficeBudget)

/**
 * Layer for the lookups' handlers, on the orders placed through Acme.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerLookups = LookupTools.toLayer(
  Effect.gen(function* () {
    const orders = yield* LiveOrders.LiveOrders

    return LookupTools.of({
      order_history: ({ office, kind, limit }) =>
        Effect.gen(function* () {
          const location = office === undefined ? undefined : Locations.findByName(office)

          if (office !== undefined && location === undefined)
            return yield* ToolFailure.fail(`No office named ${office}`)

          const live = (yield* orders.list).filter(
            (order) =>
              (location === undefined || order.locationId === location.locationId) &&
              (kind === undefined || order.kind === kind)
          )

          const history = Orders.list({ locationId: location?.locationId, kind, limit: Math.min(limit ?? 10, 30) })

          return { placedThroughAcme: live, history }
        }),
      order_status: ({ order }) =>
        Effect.gen(function* () {
          const live = yield* orders.get(order)

          if (live !== undefined) return live

          const past = Orders.find(order) ?? Orders.find(`order:${order}`)

          if (past === undefined) return yield* ToolFailure.fail(`No order ${order}. Check order_history.`)

          return past
        }),
      offices: ({ name }) => {
        if (name === undefined) return Effect.succeed(Locations.all)

        const location = Locations.findByName(name)

        return location === undefined ? ToolFailure.fail(`No office named ${name}`) : Effect.succeed([location])
      },
      office_budget: ({ office }) => {
        const location = Locations.findByName(office)

        return location === undefined
          ? ToolFailure.fail(`No office named ${office}`)
          : PrintOrders.officeBudget(location).pipe(Effect.provideService(LiveOrders.LiveOrders, orders))
      }
    })
  })
)

const SimilarCampaigns = Tool.make("similar_campaigns", {
  description: "Past campaigns similar to a subject (name, audience, theme, or city), with their budgets and ids.",
  parameters: Schema.Struct({ subject: Schema.String }),
  success: Schema.Array(Orders.PastCampaign)
})

const AllCampaigns = Tool.make("all_campaigns", {
  description: "Every campaign in the order history, newest first, with ids. Use it for reports across offices.",
  success: Schema.Array(Orders.PastCampaign)
})

/** How long one campaign lookup takes, so a report builds up over time: `DEMO_LOOKUP_SECONDS`, default 3. */
const lookupDelay = Effect.gen(function* () {
  return Duration.seconds(yield* Config.Int("DEMO_LOOKUP_SECONDS").pipe(Config.withDefault(3)))
}).pipe(Effect.orDie)

const CampaignPerformance = Tool.make("campaign_performance", {
  description:
    "How one campaign performed: spend, impressions, clicks, conversions, CTR, and cost per conversion. Slow: a few seconds per campaign, so call it for several campaigns in one step.",
  parameters: Schema.Struct({
    campaign: Schema.String.annotate({ description: "The campaign's order id, like order:summer-2026." })
  }),
  success: Performance.CampaignPerformance,
  failure: ToolFailure.ToolFailure
})

/**
 * The research specialist's own tools: past campaigns and their results.
 *
 * @category toolkits
 * @since 0.1.0
 */
export const ResearchTools = Toolkit.make(SimilarCampaigns, AllCampaigns, CampaignPerformance)

/**
 * Layer for the research tools' handlers.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerResearchTools = ResearchTools.toLayer({
  similar_campaigns: ({ subject }) => Effect.succeed(Orders.rankSimilar(Orders.pastCampaigns, subject, 6)),
  all_campaigns: () => Effect.succeed(Orders.pastCampaigns),
  campaign_performance: ({ campaign }) =>
    Effect.gen(function* () {
      yield* Effect.sleep(yield* lookupDelay)
      const results = Performance.forCampaign(campaign) ?? Performance.forCampaign(`order:${campaign}`)

      if (results === undefined) {
        return yield* ToolFailure.fail(`No campaign ${campaign}. Use an id from all_campaigns.`)
      }

      return results
    })
})

/**
 * Layer for the research specialist's handler: its prompt from `Prompts`,
 * and the campaign and order tools. It runs on the assistant's model.
 *
 * @category specialists
 * @since 0.1.0
 */
export const layerResearch = Research.toLayer(
  Effect.gen(function* () {
    const prompts = yield* Prompts.Prompts
    const toolkit = AssistantLoop.tools(yield* Toolkit.merge(ResearchTools, Toolkit.make(OrderHistory, OfficeBudget)))

    return Effect.fn(function* (run) {
      return run.loop({ instructions: yield* prompts.get("acme-specialist-research"), toolkit, maxSteps: 24 })
    })
  })
).pipe(Layer.provide(layerResearchTools))
