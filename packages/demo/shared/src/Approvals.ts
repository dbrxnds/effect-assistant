/**
 * The tool calls the user approves before they run, with their params'
 * schemas: the tools' parameters, shared so the web app shows each call
 * typed without the tools (whose handlers are the API's).
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * What `place_order` places: a product order, as `quote_order` returned it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PlaceOrderParams = Schema.Struct({
  office: Schema.String,
  product: Schema.String,
  quantity: Schema.Int,
  total: Schema.Finite.annotate({ description: "In USD, from quote_order." }),
  remainingBudget: Schema.Finite.annotate({ description: "The office's budget left after it, from quote_order." })
})

/**
 * What `start_campaign` starts.
 *
 * @category schemas
 * @since 0.1.0
 */
export const StartCampaignParams = Schema.Struct({
  campaignId: Schema.String.annotate({ description: "From list_campaign_products." }),
  campaign: Schema.String.annotate({ description: "The campaign product's name." }),
  office: Schema.String.annotate({ description: "The office paying for it." }),
  audience: Schema.String,
  budget: Schema.Finite.annotate({ description: "In USD." })
})

/**
 * Every call the user approves, by tool: what the chat's timeline shows.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Approvals = { place_order: PlaceOrderParams, start_campaign: StartCampaignParams }
