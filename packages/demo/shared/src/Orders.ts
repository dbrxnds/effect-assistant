/**
 * The demo order history: product orders and distribution campaigns across
 * the offices, from October 2025 to September 2026. A few are still in
 * flight (printing, shipped, live), so "where's my order?" has answers.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Locations from "./Locations.ts"
import * as Products from "./Products.ts"

const OrderSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))

/**
 * Schema for order ids: `order:` plus a slug.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OrderId = Schema.TemplateLiteral(["order:", OrderSlug]).pipe(Schema.brand("acme/OrderId"))

/**
 * An order id.
 *
 * @category models
 * @since 0.1.0
 */
export type OrderId = typeof OrderId.Type

const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))

/**
 * Where a product order is: placed, printing, on its way, or delivered.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ProductStatus = Schema.Literals(["placed", "in_production", "shipped", "delivered", "cancelled"])

/**
 * Where a campaign is.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CampaignStatus = Schema.Literals(["scheduled", "live", "completed", "cancelled"])

/**
 * Where a campaign runs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Channel = Schema.Literals(["social", "display", "search", "email", "out_of_home"])

const OrderFields = {
  orderId: OrderId,
  placedOn: IsoDate,
  locationId: Locations.LocationId,
  locationName: Schema.NonEmptyString
}

/**
 * An order for physical products.
 *
 * @category models
 * @since 0.1.0
 */
export class ProductOrder extends Schema.Class<ProductOrder>("acme/ProductOrder")({
  ...OrderFields,
  kind: Schema.Literal("product"),
  status: ProductStatus,
  sku: Products.Sku,
  productName: Schema.NonEmptyString,
  quantity: Schema.Int,
  /** In USD. */
  total: Schema.Finite,
  trackingNumber: Schema.optional(Schema.String)
}) {}

/**
 * An order for a distribution campaign.
 *
 * @category models
 * @since 0.1.0
 */
export class CampaignOrder extends Schema.Class<CampaignOrder>("acme/CampaignOrder")({
  ...OrderFields,
  kind: Schema.Literal("campaign"),
  status: CampaignStatus,
  name: Schema.NonEmptyString,
  audience: Schema.NonEmptyString,
  /** In USD. */
  budget: Schema.Finite,
  channels: Schema.Array(Channel),
  startDate: IsoDate,
  endDate: IsoDate,
  summary: Schema.NonEmptyString
}) {}

/**
 * Schema for any order.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Order = Schema.Union([ProductOrder, CampaignOrder])

/**
 * Any order.
 *
 * @category models
 * @since 0.1.0
 */
export type Order = typeof Order.Type

/**
 * A past campaign, as the research tools return it.
 *
 * @category models
 * @since 0.1.0
 */
export class PastCampaign extends Schema.Class<PastCampaign>("acme/PastCampaign")({
  orderId: OrderId,
  name: Schema.NonEmptyString,
  audience: Schema.NonEmptyString,
  budget: Schema.Finite,
  placedOn: IsoDate,
  channels: Schema.Array(Channel),
  status: CampaignStatus,
  summary: Schema.NonEmptyString,
  locationName: Schema.NonEmptyString
}) {}

const office = (slug: string) => {
  const found = Locations.find(Locations.LocationId.make(`location:${slug}`))

  if (found === undefined) throw new Error(`missing demo office ${slug}`)

  return { locationId: found.locationId, locationName: found.name }
}

const productOrder = (
  slug: string,
  placedOn: string,
  status: typeof ProductStatus.Type,
  officeSlug: string,
  sku: string,
  quantity: number,
  trackingNumber?: string
): ProductOrder => {
  const item = Products.find(sku)

  if (item === undefined) throw new Error(`missing demo product ${sku}`)

  return ProductOrder.make({
    orderId: OrderId.make(`order:${slug}`),
    placedOn,
    ...office(officeSlug),
    kind: "product",
    status,
    sku: item.sku,
    productName: item.name,
    quantity,
    total: Math.round(quantity * item.unitPrice * 100) / 100,
    trackingNumber
  })
}

const campaignOrder = (
  slug: string,
  placedOn: string,
  status: typeof CampaignStatus.Type,
  officeSlug: string,
  fields: {
    readonly name: string
    readonly audience: string
    readonly budget: number
    readonly channels: ReadonlyArray<typeof Channel.Type>
    readonly startDate: string
    readonly endDate: string
    readonly summary: string
  }
): CampaignOrder =>
  CampaignOrder.make({
    orderId: OrderId.make(`order:${slug}`),
    placedOn,
    ...office(officeSlug),
    kind: "campaign",
    status,
    ...fields,
    channels: [...fields.channels]
  })

/**
 * The latest summer campaign in the demo data.
 *
 * @category constants
 * @since 0.1.0
 */
export const summerCampaignId = OrderId.make("order:summer-2026")

/**
 * The latest summer campaign.
 *
 * @category constants
 * @since 0.1.0
 */
export const summerCampaign = campaignOrder("summer-2026", "2026-05-20", "completed", "amsterdam", {
  name: "Summer Campaign",
  audience: "Parents planning warm-weather trips",
  budget: 6800,
  channels: ["social", "display"],
  startDate: "2026-06-01",
  endDate: "2026-08-31",
  summary: "Social and display flight for parents booking summer travel. Ran through August; best CTR of the year."
})

const campaigns: ReadonlyArray<CampaignOrder> = [
  summerCampaign,
  campaignOrder("back-to-school-ams-2026", "2026-08-12", "live", "amsterdam", {
    name: "Back to School",
    audience: "Families with school-age kids",
    budget: 5200,
    channels: ["social", "search"],
    startDate: "2026-08-20",
    endDate: "2026-10-05",
    summary: "Search and social for back-to-school supplies. Live now."
  }),
  campaignOrder("autumn-launch-lon-2026", "2026-09-15", "scheduled", "london", {
    name: "Autumn Launch",
    audience: "Young professionals in London",
    budget: 7400,
    channels: ["display", "out_of_home"],
    startDate: "2026-10-01",
    endDate: "2026-11-15",
    summary: "Tube and bus-shelter out-of-home plus display, for the autumn product launch. Starts 1 October."
  }),
  campaignOrder("summer-sale-nyc-2026", "2026-06-28", "completed", "new-york", {
    name: "Summer Sale",
    audience: "Shoppers chasing warm-weather discounts",
    budget: 3100,
    channels: ["social"],
    startDate: "2026-07-01",
    endDate: "2026-07-31",
    summary: "Short paid social push for warm-weather discounts. Strong first week, tailed off."
  }),
  campaignOrder("fashion-week-par-2026", "2026-02-10", "completed", "paris", {
    name: "Fashion Week",
    audience: "Style-conscious city dwellers",
    budget: 8900,
    channels: ["out_of_home", "social"],
    startDate: "2026-02-25",
    endDate: "2026-03-10",
    summary: "Metro posters and Instagram around Paris Fashion Week. Highest reach of the year."
  }),
  campaignOrder("spring-refresh-ber-2026", "2026-03-18", "completed", "berlin", {
    name: "Spring Refresh",
    audience: "Homeowners planning renovations",
    budget: 4300,
    channels: ["search", "display"],
    startDate: "2026-04-01",
    endDate: "2026-05-15",
    summary: "Search-led spring campaign for home products."
  }),
  campaignOrder("lunar-new-year-sin-2026", "2026-01-12", "completed", "singapore", {
    name: "Lunar New Year",
    audience: "Families shopping for gifts",
    budget: 5600,
    channels: ["social", "email"],
    startDate: "2026-01-20",
    endDate: "2026-02-20",
    summary: "Gifting campaign with a red-envelope promo. Email drove most conversions."
  }),
  campaignOrder("holiday-gifting-nyc-2025", "2025-11-03", "completed", "new-york", {
    name: "Holiday Gifting",
    audience: "Last-minute gift shoppers",
    budget: 9800,
    channels: ["search", "social", "display"],
    startDate: "2025-11-20",
    endDate: "2025-12-24",
    summary: "Biggest campaign of the year, peaking the week before Christmas."
  }),
  campaignOrder("winter-clearance-lon-2026", "2026-01-05", "completed", "london", {
    name: "Winter Clearance",
    audience: "Bargain shoppers after the holidays",
    budget: 3200,
    channels: ["display"],
    startDate: "2026-01-07",
    endDate: "2026-01-31",
    summary: "January display clearance for leftover winter stock."
  }),
  campaignOrder("verano-mad-2026", "2026-06-02", "completed", "madrid", {
    name: "Verano",
    audience: "Young adults planning holidays",
    budget: 3900,
    channels: ["social", "out_of_home"],
    startDate: "2026-06-15",
    endDate: "2026-08-15",
    summary: "Summer holiday campaign with Metro posters in Madrid."
  }),
  campaignOrder("canada-day-yyz-2026", "2026-06-10", "completed", "toronto", {
    name: "Canada Day",
    audience: "Locals planning long-weekend trips",
    budget: 2400,
    channels: ["social", "email"],
    startDate: "2026-06-24",
    endDate: "2026-07-02",
    summary: "Short long-weekend campaign. Cheap, and email did well."
  }),
  campaignOrder("black-friday-ams-2025", "2025-10-28", "completed", "amsterdam", {
    name: "Black Friday",
    audience: "Deal hunters",
    budget: 6100,
    channels: ["search", "social", "email"],
    startDate: "2025-11-24",
    endDate: "2025-12-01",
    summary: "One-week Black Friday push. Search carried it."
  })
]

const productOrders: ReadonlyArray<ProductOrder> = [
  productOrder("ams-pens-sep-2026", "2026-09-18", "in_production", "amsterdam", "PEN-ACM-BLU-50", 500),
  productOrder("nyc-totes-sep-2026", "2026-09-10", "shipped", "new-york", "TOTE-CTN-NAT", 300, "ACM-TOTE-4471-US"),
  productOrder("lon-banners-sep-2026", "2026-09-16", "placed", "london", "ROLL-UP-85", 6),
  productOrder("ams-brochures-aug-2026", "2026-08-14", "delivered", "amsterdam", "BRO-A4-TRI", 2000),
  productOrder("ams-pens-aug-2026", "2026-08-05", "delivered", "amsterdam", "PEN-ACM-BLU-50", 500),
  productOrder("ber-notebooks-aug-2026", "2026-08-21", "delivered", "berlin", "NTB-A5-DOT", 150),
  productOrder("par-stickers-jul-2026", "2026-07-22", "delivered", "paris", "STK-ACM-3IN", 1000),
  productOrder("ams-pens-jul-2026", "2026-07-08", "delivered", "amsterdam", "PEN-ACM-BLU-50", 500),
  productOrder("mad-clings-jun-2026", "2026-06-05", "delivered", "madrid", "WIN-CLING-A2", 40),
  productOrder("nyc-bottles-jun-2026", "2026-06-12", "delivered", "new-york", "BTL-STEEL-500", 120),
  productOrder("yyz-cards-jun-2026", "2026-06-02", "delivered", "toronto", "BIZ-CARD-400", 1500),
  productOrder("sin-totes-may-2026", "2026-05-14", "delivered", "singapore", "TOTE-CTN-NAT", 200),
  productOrder("lon-hoodies-apr-2026", "2026-04-20", "delivered", "london", "HOOD-ORG-NVY", 60),
  productOrder("ber-banners-mar-2026", "2026-03-25", "delivered", "berlin", "ROLL-UP-85", 4),
  productOrder("par-brochures-feb-2026", "2026-02-12", "delivered", "paris", "BRO-A4-TRI", 3000),
  productOrder("ams-notebooks-jan-2026", "2026-01-15", "delivered", "amsterdam", "NTB-A5-DOT", 200),
  productOrder("nyc-stickers-dec-2025", "2025-12-01", "delivered", "new-york", "STK-ACM-3IN", 2000),
  productOrder("sin-pens-nov-2025", "2025-11-18", "delivered", "singapore", "PEN-ACM-BLU-50", 300),
  productOrder("lon-cards-nov-2025", "2025-11-04", "delivered", "london", "BIZ-CARD-400", 1000),
  productOrder("ams-hoodies-oct-2025", "2025-10-22", "delivered", "amsterdam", "HOOD-ORG-NVY", 40),
  productOrder("mad-pens-oct-2025", "2025-10-09", "cancelled", "madrid", "PEN-ACM-BLU-50", 200)
]

/**
 * Every demo order.
 *
 * @category constants
 * @since 0.1.0
 */
export const all: ReadonlyArray<Order> = [...campaigns, ...productOrders]

/**
 * Every campaign, as a past campaign for research.
 *
 * @category constants
 * @since 0.1.0
 */
export const pastCampaigns: ReadonlyArray<PastCampaign> = campaigns.map((order) =>
  PastCampaign.make({
    orderId: order.orderId,
    name: order.name,
    audience: order.audience,
    budget: order.budget,
    placedOn: order.placedOn,
    channels: order.channels,
    status: order.status,
    summary: order.summary,
    locationName: order.locationName
  })
)

/**
 * Returns the order with an id.
 *
 * @category getters
 * @since 0.1.0
 */
export const find = (orderId: string): Order | undefined => all.find((row) => row.orderId === orderId)

/**
 * What an order costs: a campaign's budget, or a product order's total.
 *
 * @category getters
 * @since 0.1.0
 */
export const cost = (order: Order): number => (order.kind === "campaign" ? order.budget : order.total)

const words = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3)
  )

/**
 * Returns past campaigns similar to a subject, best match first, then newest.
 *
 * @category getters
 * @since 0.1.0
 */
export const rankSimilar = (
  candidates: ReadonlyArray<PastCampaign>,
  subject: string,
  limit: number
): ReadonlyArray<PastCampaign> => {
  const query = words(subject)

  return candidates
    .flatMap((campaign) => {
      const haystack = words(`${campaign.name} ${campaign.audience} ${campaign.summary} ${campaign.locationName}`)
      const score = [...query].filter((word) => haystack.has(word)).length

      return score > 0 ? [{ campaign, score }] : []
    })
    .sort((a, b) => b.score - a.score || b.campaign.placedOn.localeCompare(a.campaign.placedOn))
    .slice(0, limit)
    .map(({ campaign }) => campaign)
}

/**
 * Lists orders newest first, optionally for one office or of one kind.
 *
 * @category getters
 * @since 0.1.0
 */
export const list = (input: {
  readonly locationId?: Locations.LocationId | undefined
  readonly kind?: "product" | "campaign" | undefined
  readonly limit?: number | undefined
}): ReadonlyArray<Order> =>
  all
    .filter((order) => input.locationId === undefined || order.locationId === input.locationId)
    .filter((order) => input.kind === undefined || order.kind === input.kind)
    .sort((a, b) => b.placedOn.localeCompare(a.placedOn))
    .slice(0, input.limit ?? 20)
