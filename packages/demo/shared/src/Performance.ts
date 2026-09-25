/**
 * How campaigns performed: reach, clicks, conversions, and cost per
 * conversion. Deterministic per campaign, so answers are the same every time.
 *
 * @since 0.1.0
 */
import * as Match from "effect/Match"
import * as Schema from "effect/Schema"
import * as Orders from "./Orders.ts"

/**
 * A campaign's results so far.
 *
 * @category models
 * @since 0.1.0
 */
export class CampaignPerformance extends Schema.Class<CampaignPerformance>("acme/CampaignPerformance")({
  orderId: Orders.OrderId,
  name: Schema.NonEmptyString,
  office: Schema.NonEmptyString,
  status: Orders.CampaignStatus,
  /** In USD. */
  spend: Schema.Finite,
  impressions: Schema.Int,
  clicks: Schema.Int,
  conversions: Schema.Int,
  /** Clicks per impression, as a percentage. */
  ctr: Schema.Finite,
  /** Spend per conversion, in USD. */
  costPerConversion: Schema.Finite
}) {}

/** A stable number in [0, 1) from a string. */
const unit = (seed: string): number => {
  let hash = 2166136261

  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)

  return ((hash >>> 0) % 10000) / 10000
}

/** Impressions per dollar, clicks per impression, and conversions per click, by channel. */
const rates = {
  social: { reach: 140, ctr: 0.011, conversion: 0.034 },
  display: { reach: 260, ctr: 0.004, conversion: 0.021 },
  search: { reach: 45, ctr: 0.041, conversion: 0.052 },
  email: { reach: 90, ctr: 0.028, conversion: 0.061 },
  out_of_home: { reach: 520, ctr: 0.0008, conversion: 0.012 }
} as const

/** How much of the budget is spent: all of it when done, part of it when live. */
const spentShare = Match.type<Orders.CampaignOrder["status"]>().pipe(
  Match.when("completed", () => 1),
  Match.when("live", () => 0.45),
  Match.orElse(() => 0)
)

/**
 * Returns a campaign's results, or `undefined` for orders that aren't
 * campaigns.
 *
 * @category getters
 * @since 0.1.0
 */
export const forCampaign = (orderId: string): CampaignPerformance | undefined => {
  const order = Orders.find(orderId)

  if (order === undefined || order.kind !== "campaign") return undefined

  const spend = Math.round(order.budget * spentShare(order.status))
  const perChannel = spend / order.channels.length
  const jitter = 0.8 + unit(order.orderId) * 0.5
  let impressions = 0
  let clicks = 0
  let conversions = 0

  for (const channel of order.channels) {
    const rate = rates[channel]
    const channelImpressions = perChannel * rate.reach * jitter
    const channelClicks = channelImpressions * rate.ctr * jitter
    impressions += channelImpressions
    clicks += channelClicks
    conversions += channelClicks * rate.conversion * (0.9 + unit(`${order.orderId}:${channel}`) * 0.4)
  }

  return CampaignPerformance.make({
    orderId: order.orderId,
    name: order.name,
    office: order.locationName,
    status: order.status,
    spend,
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    conversions: Math.round(conversions),
    ctr: impressions === 0 ? 0 : Math.round((clicks / impressions) * 10000) / 100,
    costPerConversion: conversions < 1 ? 0 : Math.round((spend / conversions) * 100) / 100
  })
}
