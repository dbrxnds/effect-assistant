/**
 * Defines skills, which are playbooks with step-by-step instructions for a kind of task.
 *
 * A loop lists its skills as a catalog in the prompt, with each skill's name and description
 * ({@link withCatalog}). The model loads a skill's instructions with the `load_skill` tool when a
 * task matches.
 *
 * @since 0.1.0
 */
import type * as Instructions from "./Instructions.ts"

/**
 * Represents a skill.
 *
 * `R` is the services its instructions need when they're loaded.
 *
 * @category models
 * @since 0.1.0
 */
export interface Skill<R = never> {
  readonly name: string
  /** When to use it, in one line. This is all the model sees until it loads the skill. */
  readonly description: string
  /** Text, or an Effect resolved each time the skill is loaded. */
  readonly instructions: Instructions.Instructions<R>
}

/**
 * Creates a skill from its name, a description of when to use it, and its instructions.
 *
 * **Details**
 *
 * Write the description as a trigger ("Use when…"), since it's all the model sees until it loads
 * the skill. The instructions are text, or an Effect that is resolved each time the skill is
 * loaded.
 *
 * **Example** (Defining a playbook for ordering campaigns)
 *
 * ```ts
 * import { Skill } from "effect-assistant"
 *
 * const orderingCampaigns = Skill.make("Ordering a campaign", {
 *   description: "Use when the user wants to order or start a campaign.",
 *   instructions: `1. Pick the product with list_campaign_products.
 * 2. You need who it should reach and a budget. Ask for what's missing, one question at a time.
 * 3. When you have both, call start_campaign.`
 * })
 *
 * const MyAssistantLive = MyAssistant.toLayer((turn) =>
 *   turn.loop({ instructions, skills: [orderingCampaigns] })
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(
  name: string,
  options: {
    /** When to use it, in one line. This is all the model sees until it loads the skill. */
    readonly description: string
    /** Text, or an Effect resolved each time the skill is loaded. */
    readonly instructions: Instructions.Instructions<R>
  }
): Skill<R> => ({ name, description: options.description, instructions: options.instructions })

/**
 * Extracts the services that skills need when they're loaded.
 *
 * @category utility types
 * @since 0.1.0
 */
export type Services<S> = S extends Skill<infer R> ? R : never

/**
 * Returns the prompt with the skills' catalog appended, or the prompt unchanged when there are no
 * skills.
 *
 * @category utils
 * @since 0.1.0
 */
export const withCatalog = <R>(prompt: string, skills: ReadonlyArray<Skill<R>>): string =>
  skills.length === 0
    ? prompt
    : [
        prompt,
        "",
        "## Skills",
        "Playbooks for common tasks. When one matches what you're doing, load it with load_skill in the same step as your first lookups, and follow it.",
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`)
      ].join("\n")
