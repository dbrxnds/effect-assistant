/**
 * The UI blocks Acme can put in its messages. Shared, so the web app renders
 * exactly the blocks the assistant may send.
 *
 * @since 0.1.0
 */
import * as Block from "effect-assistant/Block"
import * as BlockKit from "effect-assistant/BlockKit"
import * as Schema from "effect/Schema"

/**
 * Buttons for picking one option.
 *
 * @category blocks
 * @since 0.1.0
 */
export const ChooseOne = Block.make("choose_one", {
  description: "Buttons for picking one of a few options, e.g. which campaign product. Keep options short.",
  props: Schema.Struct({ options: Schema.Array(Schema.String) }),
  answer: Schema.Struct({ choice: Schema.String })
})

/**
 * A small input for a short answer.
 *
 * @category blocks
 * @since 0.1.0
 */
export const TextInput = Block.make("text_input", {
  description:
    "A small input for a short free-form answer, e.g. who a campaign should reach or a budget. One question per input.",
  props: Schema.Struct({
    placeholder: Schema.String.annotate({ description: 'e.g. "Parents in Austin"' })
  }),
  answer: Schema.Struct({ value: Schema.String })
})

/**
 * A product order ready to place, with a Place order button. It has no
 * answer: the button places the order through Acme's API (`PlaceOrder`)
 * with exactly these props, and the API tells the chat.
 *
 * @category blocks
 * @since 0.1.0
 */
export const OrderDraft = Block.make("order_draft", {
  description:
    "A product order ready to place, from quote_order, with a Place order button. Only the user places it, with the button; you hear back when they do.",
  props: Schema.Struct({
    office: Schema.String,
    product: Schema.String,
    quantity: Schema.Int,
    total: Schema.Finite.annotate({ description: "In USD, from quote_order." }),
    remainingBudget: Schema.Finite.annotate({ description: "The office's budget left after it, from quote_order." })
  })
})

/**
 * A campaign ready to start, with a Start campaign button. It has no answer:
 * the button starts the campaign through Acme's API (`StartCampaign`) with
 * exactly these props, and the API tells the chat.
 *
 * @category blocks
 * @since 0.1.0
 */
export const CampaignDraft = Block.make("campaign_draft", {
  description:
    "A campaign ready to start, with a Start campaign button. Only the user starts it, with the button; you hear back when they do.",
  props: Schema.Struct({
    campaignId: Schema.String.annotate({ description: "From list_campaign_products." }),
    campaign: Schema.String.annotate({ description: "The campaign product's name." }),
    office: Schema.String.annotate({ description: "The office paying for it." }),
    audience: Schema.String,
    budget: Schema.Finite.annotate({ description: "In USD." })
  })
})

/**
 * Every block Acme can use. A choice or a short answer goes back to Acme as
 * the block's answer; an order or a campaign is placed by the user from its
 * block, through Acme's API.
 *
 * @category blocks
 * @since 0.1.0
 */
export const Blocks = BlockKit.make([ChooseOne, TextInput, OrderDraft, CampaignDraft])
