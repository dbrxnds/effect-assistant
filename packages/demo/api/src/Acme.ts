/**
 * Acme, the colleague: its handler (instructions, tools, skills), the
 * research specialist's, and the model.
 *
 * @since 0.1.0
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"
import type * as Assistant from "effect-assistant/Assistant"
import * as BlockKit from "effect-assistant/BlockKit"
import * as Skill from "effect-assistant/Skill"
import * as ToolApproval from "effect-assistant/ToolApproval"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Prompt from "effect/ai/Prompt"
import * as Toolkit from "effect/ai/Toolkit"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { AcmeAssistant } from "./AcmeAssistant.ts"
import * as Campaign from "./Campaign.ts"
import * as PrintOrders from "./PrintOrders.ts"
import * as Prompts from "./Prompts.ts"
import * as Tools from "./Tools.ts"
import * as WorkflowStep from "./WorkflowStep.ts"

const orderingCampaigns = Skill.make("Ordering a campaign", {
  description: "Use when the user wants to order or start a campaign.",
  instructions: Prompts.instructions("acme-skill-ordering")
})

const orderingProducts = Skill.make("Ordering products", {
  description: "Use when the user wants to order branded products (pens, totes, banners, ...) for an office.",
  instructions: Prompts.instructions("acme-skill-products")
})

/** Acme's playbooks, as the `load_skill` tool. Their instructions come from `Prompts` when loaded. */
const AcmeSkills = Skill.toolkit([orderingCampaigns, orderingProducts])

/** Acme's tools: campaigns, product orders, lookups, and its skills. */
const AcmeTools = Toolkit.merge(Campaign.CampaignTools, PrintOrders.PrintTools, Tools.LookupTools, AcmeSkills)

/** Their handlers, and the lookups' for the research specialist too. */
const layerTools = Layer.mergeAll(Campaign.layerTools, PrintOrders.layerTools, Tools.layerLookups, AcmeSkills.layer)

const note = (text: string) => Prompt.userMessage({ content: [Prompt.textPart({ text })] })

/** What the model reads: the chat, with each workflow step as a note the user hasn't seen. */
const history: Assistant.HistoryView<WorkflowStep.WorkflowStep> = (entries) =>
  entries.map((entry) =>
    entry.event instanceof WorkflowStep.WorkflowStep ? note(WorkflowStep.render(entry.event)) : entry
  )

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

    return Effect.fn(function* (turn) {
      const prompt = yield* prompts.get("acme")

      // A block or an order the user moved on from (three messages later) stops taking answers.
      yield* BlockKit.closeStale({ messages: 3 })
      yield* ToolApproval.closeStale({ messages: 3 })

      return turn.run({
        instructions: { ...prompt, text: `${prompt.text}\n\nToday is ${new Date().toDateString()}.` },
        toolkit: AcmeTools,
        history
      })
    })
  })
).pipe(Layer.provide(Tools.layerResearch), Layer.provide(layerTools))

/**
 * Layer for the model: Anthropic's `ACME_MODEL` with `ANTHROPIC_API_KEY`, and
 * prompt caching. The prompt, tools, and chat history only grow, so one
 * request-level cache breakpoint (Anthropic puts it on the last block) reuses
 * the prefix on every step. Tools aren't strict: Anthropic refuses the grammar
 * for this many strict tools, and the loop gives the model params that don't
 * fit back as a failure it reads.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerModel = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("ANTHROPIC_API_KEY")
    const name = yield* model
    yield* Effect.logInfo(`model: ${name}`)

    return AnthropicLanguageModel.model(name, { cache_control: { type: "ephemeral" }, strictJsonSchema: false }).pipe(
      Layer.provide(AnthropicClient.layer({ apiKey })),
      Layer.provide(FetchHttpClient.layer)
    )
  })
)
