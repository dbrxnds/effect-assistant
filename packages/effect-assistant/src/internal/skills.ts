import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Instructions from "../Instructions.ts"
import type { Skill } from "../Skill.ts"
import * as ToolFailure from "../ToolFailure.ts"
import * as Toolkits from "./toolkit.ts"

// A skill whose tools the loop doesn't have would send the model after calls it can't make.
/** @internal */
export const available = <R>(
  skills: ReadonlyArray<Skill<R>>,
  definitions: ReadonlyArray<Tool.Any>
): ReadonlyArray<Skill<R>> => {
  const names = new Set(definitions.map((tool) => tool.name))

  return skills.filter((skill) => (skill.tools ?? []).every((tool) => names.has(tool.name)))
}

/** @internal */
export const toTools = <R>(skills: ReadonlyArray<Skill<R>>): Toolkits.Tools<R> => {
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
