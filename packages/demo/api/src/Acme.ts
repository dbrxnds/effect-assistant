/**
 * Acme, the colleague: its handler (instructions, tools, skills), the
 * research specialist's, and the model.
 *
 * @since 0.1.0
 */
import * as Anthropic from "@effect-uai/anthropic/Anthropic"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as BlockKit from "effect-assistant/BlockKit"
import * as Skill from "effect-assistant/Skill"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { AcmeAssistant } from "./AcmeAssistant.ts"
import * as Campaign from "./Campaign.ts"
import * as PrintOrders from "./PrintOrders.ts"
import * as Prompts from "./Prompts.ts"
import * as Tools from "./Tools.ts"

const orderingCampaigns = Skill.make({
  name: "Ordering a campaign",
  description: "Use when the user wants to order or start a campaign.",
  instructions: Prompts.instructions("acme-skill-ordering")
})

const orderingProducts = Skill.make({
  name: "Ordering products",
  description: "Use when the user wants to order branded products (pens, totes, banners, ...) for an office.",
  instructions: Prompts.instructions("acme-skill-products")
})

const toolkit = {
  ...Toolkit.make(
    Campaign.listCampaignProducts,
    Campaign.startCampaign,
    Campaign.decideCampaign,
    PrintOrders.productCatalog,
    PrintOrders.orderProducts,
    Tools.orderHistory,
    Tools.orderStatus,
    Tools.offices,
    Tools.officeBudget
  )
}

/** The model Acme and its specialists use: `ACME_MODEL`, default `claude-sonnet-5`. */
export const model = Config.String("ACME_MODEL").pipe(Config.withDefault("claude-sonnet-5"))

/**
 * Layer for Acme: registers its handler, with the research specialist's,
 * with the assistant engine. The prompt comes from `Prompts` every turn, plus
 * today's date: the data and the budgets are about "now".
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = AcmeAssistant.toLayer(
  Effect.gen(function* () {
    const prompts = yield* Prompts.Prompts
    const name = yield* model

    return Effect.fn(function* (turn) {
      const prompt = yield* prompts.get("acme")

      // A block the user moved on from (three messages later) stops taking answers.
      yield* BlockKit.closeStale({ messages: 3 })

      return turn.loop({
        model: name,
        instructions: { ...prompt, text: `${prompt.text}\n\nToday is ${new Date().toDateString()}.` },
        toolkit,
        skills: [orderingCampaigns, orderingProducts]
      })
    })
  })
).pipe(Layer.provide(Tools.layerResearch(model)))

/**
 * Layer for the model API: Anthropic with `ANTHROPIC_API_KEY`, and prompt
 * caching. The prompt, tools, and chat history only grow, so caching reuses
 * the prefix on every step.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerModel = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("ANTHROPIC_API_KEY")
    yield* Effect.logInfo(`model: ${yield* model}`)

    return Anthropic.layer({ apiKey, promptCaching: true }).pipe(Layer.provide(FetchHttpClient.layer))
  })
)
