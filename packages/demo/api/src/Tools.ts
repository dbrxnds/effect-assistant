/**
 * Acme's lookups (orders, offices, budgets, campaign results) and its
 * research specialist, backed by the demo data in `@acme/demo-shared` and
 * the orders placed through Acme.
 *
 * @since 0.1.0
 */
import * as Locations from "@acme/demo-shared/Locations"
import * as Orders from "@acme/demo-shared/Orders"
import * as Performance from "@acme/demo-shared/Performance"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as LiveOrders from "./LiveOrders.ts"
import * as PrintOrders from "./PrintOrders.ts"
import * as Prompts from "./Prompts.ts"
import { Research } from "./Research.ts"

const OfficeInput = Schema.optional(Schema.String).annotate({ description: "Office name, like Amsterdam." })

const OrderHistoryInput = Schema.Struct({
  office: OfficeInput,
  kind: Schema.optional(Schema.Literals(["product", "campaign"])),
  limit: Schema.optional(Schema.Int)
})

/**
 * Lists recent orders, newest first: those placed through Acme, then the
 * order history.
 *
 * @category tools
 * @since 0.1.0
 */
export const orderHistory = Tool.make({
  name: "order_history",
  description:
    "Recent product and campaign orders, newest first, including the ones placed through you. Optionally for one office or one kind.",
  inputSchema: OrderHistoryInput,
  run: Effect.fn(function* ({ office, kind, limit }: typeof OrderHistoryInput.Type) {
    const location = office === undefined ? undefined : Locations.findByName(office)

    if (office !== undefined && location === undefined) return yield* Tool.fail(`No office named ${office}`)

    const live = (yield* (yield* LiveOrders.LiveOrders).list).filter(
      (order) =>
        (location === undefined || order.locationId === location.locationId) &&
        (kind === undefined || order.kind === kind)
    )

    const history = Orders.list({ locationId: location?.locationId, kind, limit: Math.min(limit ?? 10, 30) })

    return { placedThroughAcme: live, history }
  })
})

const StatusInput = Schema.Struct({
  order: Schema.String.annotate({ description: "An order reference like ACM-7K2Q9X, or an order id." })
})

/**
 * Returns where an order is.
 *
 * @category tools
 * @since 0.1.0
 */
export const orderStatus = Tool.make({
  name: "order_status",
  description: "Where one order is now: status, tracking, and what it contains.",
  inputSchema: StatusInput,
  run: Effect.fn(function* ({ order }: typeof StatusInput.Type) {
    const live = yield* (yield* LiveOrders.LiveOrders).get(order)

    if (live !== undefined) return live

    const past = Orders.find(order) ?? Orders.find(`order:${order}`)

    if (past === undefined) return yield* Tool.fail(`No order ${order}. Check order_history.`)

    return past
  })
})

const OfficesInput = Schema.Struct({ name: OfficeInput })

/**
 * Lists offices, or finds one by name.
 *
 * @category tools
 * @since 0.1.0
 */
export const offices = Tool.make({
  name: "offices",
  description:
    "Acme offices: address, locale, contact, and default ship-to. Use for 'where is the X office', office addresses, or listing all offices. Pass a city or office name to get one; omit name to list all.",
  inputSchema: OfficesInput,
  run: Effect.fn(function* ({ name }: typeof OfficesInput.Type) {
    if (name === undefined) return Locations.all

    const location = Locations.findByName(name)

    if (location === undefined) return yield* Tool.fail(`No office named ${name}`)

    return [location]
  })
})

const BudgetInput = Schema.Struct({ office: Schema.String.annotate({ description: "Office name, like Amsterdam." }) })

/**
 * Returns an office's marketing budget this quarter.
 *
 * @category tools
 * @since 0.1.0
 */
export const officeBudget = Tool.make({
  name: "office_budget",
  description:
    "An office's marketing budget this quarter: total, spent (including orders placed through you), and left.",
  inputSchema: BudgetInput,
  run: Effect.fn(function* ({ office }: typeof BudgetInput.Type) {
    const location = Locations.findByName(office)

    if (location === undefined) return yield* Tool.fail(`No office named ${office}`)

    return yield* PrintOrders.officeBudget(location)
  })
})

const SimilarInput = Schema.Struct({ subject: Schema.String })

const similarCampaigns = Tool.make({
  name: "similar_campaigns",
  description: "Past campaigns similar to a subject (name, audience, theme, or city), with their budgets and ids.",
  inputSchema: SimilarInput,
  run: ({ subject }) => Effect.succeed(Orders.rankSimilar(Orders.pastCampaigns, subject, 6))
})

const allCampaigns = Tool.make({
  name: "all_campaigns",
  description: "Every campaign in the order history, newest first, with ids. Use it for reports across offices.",
  inputSchema: Tool.noInput,
  run: () => Effect.succeed(Orders.pastCampaigns)
})

/** How long one campaign lookup takes, so a report builds up over time: `DEMO_LOOKUP_SECONDS`, default 3. */
const lookupDelay = Effect.gen(function* () {
  return Duration.seconds(yield* Config.Int("DEMO_LOOKUP_SECONDS").pipe(Config.withDefault(3)))
}).pipe(Effect.orDie)

const PerformanceInput = Schema.Struct({
  campaign: Schema.String.annotate({ description: "The campaign's order id, like order:summer-2026." })
})

const campaignPerformance = Tool.make({
  name: "campaign_performance",
  description:
    "How one campaign performed: spend, impressions, clicks, conversions, CTR, and cost per conversion. Slow: a few seconds per campaign, so call it for several campaigns in one step.",
  inputSchema: PerformanceInput,
  run: Effect.fn(function* ({ campaign }: typeof PerformanceInput.Type) {
    yield* Effect.sleep(yield* lookupDelay)
    const results = Performance.forCampaign(campaign) ?? Performance.forCampaign(`order:${campaign}`)

    if (results === undefined) return yield* Tool.fail(`No campaign ${campaign}. Use an id from all_campaigns.`)

    return results
  })
})

/**
 * Layer for the research specialist's handler: its prompt from `Prompts`,
 * the campaign and order tools, and the model `model` names.
 *
 * @category specialists
 * @since 0.1.0
 */
export const layerResearch = (model: Config.Config<string>) =>
  Research.toLayer(
    Effect.gen(function* () {
      const prompts = yield* Prompts.Prompts
      const name = yield* model
      const toolkit = Toolkit.make(similarCampaigns, allCampaigns, campaignPerformance, orderHistory, officeBudget)

      return Effect.fn(function* (run) {
        return run.loop({
          model: name,
          instructions: yield* prompts.get("acme-specialist-research"),
          toolkit,
          maxSteps: 24
        })
      })
    })
  )
