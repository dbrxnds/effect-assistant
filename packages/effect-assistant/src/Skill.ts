/**
 * The `Skill` module defines playbooks: step-by-step instructions for a kind
 * of task.
 *
 * @since 0.1.0
 */
import type * as Instructions from "./Instructions.ts"

/**
 * A skill. `R` is what its instructions need when they're loaded.
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
 * Creates a skill.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(skill: Skill<R>): Skill<R> => skill

/**
 * Returns what skills need when they're loaded.
 *
 * @category utility types
 * @since 0.1.0
 */
export type Services<S> = S extends Skill<infer R> ? R : never

/**
 * Returns the prompt with the skills' catalog appended, or the prompt as is
 * when there are none.
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
