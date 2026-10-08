/**
 * Acme's prompts, from Langfuse prompt management with the text here as the
 * fallback.
 *
 * `Prompts` is a service, so a handler uses it like any other: it gets the
 * prompt every turn (`prompts.get("acme")`), and the layer picks the source.
 * A skill's instructions can be `Prompts.instructions(name)`, resolved when
 * the skill is loaded.
 *
 * - {@link layerLangfuse} reads the prompt with the `ACME_PROMPT_LABEL`
 *   label (default `production`) on every turn. The client caches it for a
 *   minute, so a new version is live within a minute without a deploy. Model
 *   calls get the prompt's name and version as span attributes, which links
 *   each generation to it in Langfuse. When a fetch fails, the text here is
 *   used.
 * - {@link layerDefaults} always uses the text here.
 *
 * `pnpm prompts:push` uploads the text here as new versions.
 *
 * @since 0.1.0
 */
import { LangfuseClient } from "@langfuse/client"
import type * as Instructions from "effect-assistant/Instructions"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Observability from "./Observability.ts"

/**
 * The prompts in code: the fallback, and what `prompts:push` uploads.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaults = {
  acme: `You are Acme, a colleague on a small marketing team with eight offices (Amsterdam, New York, London, Paris, Berlin, Singapore, Madrid, Toronto).
You can order campaigns and branded products (pens, totes, banners, ...), track orders, check each office's budget this quarter, look up offices (addresses and contacts with the offices tool), and have the research specialist dig into past campaigns and their results.
Use your tools for anything about orders, offices, budgets, or campaigns; don't answer those from memory, and never invent an order, date, audience, budget, or number.
When someone asks where an office is, what offices you have, or for an office address or contact, call offices (with the city or office name when they mean one office).
Placing an order or starting a campaign needs the user's decision: ask with a decision block, never with a question in words, and say what they approve (product or campaign, office, quantity or audience, total or budget). Only their answer to that block decides it.
Orders run in the background and report back as <workflow> updates. Tell the user what matters (going live, shipped with tracking, delivered, results, problems); keep routine steps to yourself.
For slow work (a report, a comparison), start the research specialist, tell the user in one line, and follow up when its report arrives. Keep chatting meanwhile.
Voice: warm, direct, short, like texting a coworker. First sentence answers the question. No filler like "Certainly" or "Great question".`,
  "acme-skill-ordering": `1. Pick the product with list_campaign_products. If it's unclear which one, ask with a choose_one block of the product names.
2. You need which office pays, who it should reach, and a budget in USD. Ask for what's missing, one short question at a time. Check office_budget if the budget might not fit. If they want a suggestion, delegate to the research specialist and keep chatting.
3. When you have everything, call start_campaign right away. Don't ask them to confirm yet: the call waits for their decision.
4. Sum up the order (campaign, office, audience, budget, and the office's budget left after it, from office_budget) in one line and ask with a decision block for its decisionId, labeled Approve / Decline. If they answer in words instead, send the decision block again: only its answer decides. Once they approve, tell them the reference in one line; if they decline, say it's cancelled.
5. Updates from the CreateCampaign workflow tell you how the run goes:
   - creative_in_progress and scheduled are routine: keep them to yourself.
   - live: tell them, with the reference.
   - first_results: share the key numbers in one or two lines (spend, clicks, conversions, cost per conversion).`,
  "acme-skill-products": `1. Find the product with product_catalog. If it's unclear which one, ask with a choose_one block of a few product names.
2. You need the office and a quantity. Ask for what's missing. Quantities round up to whole packs and the minimum; say so if it changes the number.
3. Call quote_order. If the budget doesn't cover it, say how much is left and suggest a smaller quantity.
4. Call order_products. It waits for the user's decision: from the quote, say the product, quantity, total, and budget left in one line, and ask with a decision block for its decisionId, labeled Place order / Cancel. Ordering several products at once, ask for all of them in one block.
5. Once they approve, tell them the reference in one line. If they decline, say it's cancelled.
6. Updates from the PrintOrder workflow: confirmed and printing are routine, keep them to yourself. On shipped, share the carrier and tracking number. On delivered, one short line.`,
  "acme-specialist-research": `You research Acme's past campaigns, their results, orders, and budgets with your tools.
For a report across campaigns, list them with all_campaigns or similar_campaigns, then look up campaign_performance for the relevant ones. Call several lookups in the same step: each takes a few seconds.
Answer with the findings and numbers the colleague needs: a short ranking or table, then one or two recommendations. Say when the data doesn't cover the question.`
} as const

/**
 * The name of a managed prompt.
 *
 * @category models
 * @since 0.1.0
 */
export type Name = keyof typeof defaults

/**
 * Service that returns the current version of a prompt.
 *
 * @category services
 * @since 0.1.0
 */
export class Prompts extends Context.Service<
  Prompts,
  {
    readonly get: (name: Name) => Effect.Effect<Instructions.Resolved>
  }
>()("acme/Prompts") {}

/**
 * Returns a prompt as instructions for an assistant, specialist, or skill.
 *
 * @category constructors
 * @since 0.1.0
 */
export const instructions: (name: Name) => Effect.Effect<Instructions.Resolved, never, Prompts> = Effect.fn(function* (
  name: Name
) {
  const prompts = yield* Prompts

  return yield* prompts.get(name)
})

/**
 * Layer that always uses the prompts in code.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerDefaults: Layer.Layer<Prompts> = Layer.succeed(Prompts, {
  get: (name) => Effect.succeed({ text: defaults[name] })
})

/**
 * Layer that reads prompts from Langfuse with the `ACME_PROMPT_LABEL` label
 * (default `production`).
 *
 * @category layers
 * @since 0.1.0
 */
export const layerLangfuse = (options: {
  readonly publicKey: string
  readonly secretKey: string
  readonly baseUrl?: string | undefined
}): Layer.Layer<Prompts, Config.ConfigError> =>
  Layer.effect(
    Prompts,
    Effect.gen(function* () {
      const client = new LangfuseClient(options)
      const label = yield* Config.String("ACME_PROMPT_LABEL").pipe(Config.withDefault("production"))

      return Prompts.of({
        get: (name) =>
          Effect.tryPromise(() =>
            client.prompt.get(name, { label, cacheTtlSeconds: 60, fallback: defaults[name], fetchTimeoutMs: 3000 })
          ).pipe(
            Effect.map((prompt): Instructions.Resolved =>
              prompt.isFallback
                ? { text: prompt.prompt }
                : {
                    text: prompt.prompt,
                    attributes: {
                      "langfuse.observation.prompt.name": prompt.name,
                      "langfuse.observation.prompt.version": prompt.version
                    }
                  }
            ),
            Effect.orElseSucceed(() => ({ text: defaults[name] }))
          )
      })
    })
  )

/**
 * Langfuse when its keys are set, the prompts in code otherwise.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Prompts, Config.ConfigError> = Layer.unwrap(
  Effect.gen(function* () {
    const credentials = yield* Observability.langfuse

    return Option.isSome(credentials) ? layerLangfuse(Observability.clientOptions(credentials.value)) : layerDefaults
  })
)
