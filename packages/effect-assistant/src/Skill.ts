/**
 * The `Skill` module defines playbooks: step-by-step instructions for a kind
 * of task.
 */
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as AssistantLoop from "./AssistantLoop.ts"
import * as Instructions from "./Instructions.ts"
import * as Toolkits from "./internal/toolkit.ts"
import * as ToolFailure from "./ToolFailure.ts"

/** A skill. `R` is what its instructions need when they're loaded. */
export interface Skill<R = never> {
  readonly name: string
  /** When to use it, in one line. This is all the model sees until it loads the skill. */
  readonly description: string
  /** Text, or an Effect resolved each time the skill is loaded. */
  readonly instructions: Instructions.Instructions<R>
}

/** Creates a skill. */
export const make = <R = never>(skill: Skill<R>): Skill<R> => skill

/** Returns what skills need when they're loaded. */
export type Services<S> = S extends Skill<infer R> ? R : never

/**
 * Returns the prompt with the skills' catalog appended, or the prompt as is
 * when there are none.
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

/**
 * Returns the `load_skill` tool for these skills, or no tools when there are
 * none.
 */
export const toTools = <R>(skills: ReadonlyArray<Skill<R>>): AssistantLoop.Tools<R> => {
  if (skills.length === 0) return Toolkits.empty

  const byName = new Map(skills.map((skill) => [skill.name, skill]))

  const LoadSkill = Tool.make("load_skill", {
    description:
      "Load a skill's instructions by name, in the same step as your first lookups (not in a step of its own). Follow them for the rest of the task.",
    parameters: Schema.Struct({ name: Schema.Literals(skills.map((skill) => skill.name)) }),
    success: Schema.String,
    failure: ToolFailure.ToolFailure
  })

  // A skill's instructions resolve with the services of the loop that loads it.
  return Toolkits.withContext(Toolkit.make(LoadSkill), (context: Context.Context<R>) => ({
    load_skill: Effect.fnUntraced(function* ({ name }) {
      const skill = byName.get(name)

      if (skill === undefined) return yield* ToolFailure.fail(`No skill named ${name}.`)

      const resolved = yield* Instructions.resolve(skill.instructions).pipe(Effect.provideContext(context))

      return resolved.text
    })
  }))
}
