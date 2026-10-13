/**
 * The research specialist's definition. Its handler is in the API's
 * `Tools.ts`, next to the tools it uses.
 *
 * @since 0.1.0
 */
import * as Specialist from "effect-assistant/Specialist"

/**
 * The research specialist: compares past campaigns, looks up their results,
 * and suggests budgets.
 *
 * @category specialists
 * @since 0.1.0
 */
export const Research = Specialist.make("research", {
  description:
    "Researches past campaigns, their results, orders, and budgets: compares options, builds performance reports, suggests budgets. Big reports take a minute or so. Give it the question and any context."
})
