/**
 * The `Skill` module defines playbooks: step-by-step instructions for a kind
 * of task.
 *
 * A handler gives its loop a catalog of skills (`turn.loop({ skills })` or
 * `run.loop({ skills })`). Each skill's name and description ("use when…")
 * go in the prompt, and a `load_skill` tool returns a skill's instructions
 * when a task matches. The instructions then sit in the history for the rest
 * of the work. Load-on-match keeps long playbooks out of the prompt until
 * they are needed.
 *
 * **Example** (A skill)
 *
 * ```ts
 * import { Skill } from "effect-assistant"
 *
 * const onboarding = Skill.make({
 *   name: "Onboarding",
 *   description: "Use when someone new is joining the team.",
 *   instructions: "1. Send the welcome pack. 2. Book a buddy lunch on day one. 3. Set up their laptop."
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Instructions from "./Instructions.ts"

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
 * @category combinators
 * @since 0.1.0
 */
export const withCatalog = <R>(prompt: string, skills: ReadonlyArray<Skill<R>>): string =>
  skills.length === 0
    ? prompt
    : [
        prompt,
        "",
        "## Skills",
        "Playbooks for common tasks. When one matches what you're doing, load it with load_skill and follow it.",
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`)
      ].join("\n")

/**
 * Returns the `load_skill` tool for these skills, or an empty toolkit when
 * there are none.
 *
 * @category constructors
 * @since 0.1.0
 */
export const toolkit = <R>(skills: ReadonlyArray<Skill<R>>): Toolkit.Toolkit => {
  if (skills.length === 0) return {}

  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const Input = Schema.Struct({ name: Schema.Literals(skills.map((skill) => skill.name)) })

  return Toolkit.make(
    Tool.make({
      name: "load_skill",
      description: "Load a skill's instructions by name. Follow them for the rest of the task.",
      inputSchema: Input,
      run: Effect.fn(function* ({ name }: typeof Input.Type) {
        const skill = byName.get(name)

        if (skill === undefined) return yield* Tool.fail(`No skill named ${name}.`)

        return (yield* Instructions.resolve(skill.instructions)).text
      })
    })
  )
}
