/**
 * Defines skills, which are playbooks with step-by-step instructions for a kind of task.
 *
 * A list of skills becomes a toolkit with one tool, `load_skill` ({@link toolkit}). Its
 * description is the catalog, each skill's name and when to use it, and the model calls it to read
 * a skill's instructions when a task matches. Merge it into a loop's toolkit like any other.
 *
 * @since 0.1.0
 */
import * as Tool from "effect/ai/Tool"
import * as AiToolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Instructions from "./Instructions.ts"
import * as ToolFailure from "./ToolFailure.ts"

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
 * loaded. Offer skills to a loop with {@link toolkit}.
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

const loadSkill = (description: string) =>
  Tool.make("load_skill", {
    description,
    parameters: Schema.Struct({ name: Schema.String }),
    success: Schema.String,
    failure: ToolFailure.ToolFailure
  })

/**
 * Represents the `load_skill` tool, which reads a skill's instructions by name.
 *
 * @category models
 * @since 0.4.0
 */
export type LoadSkill = ReturnType<typeof loadSkill>

/**
 * Represents a list of skills as a toolkit: the `load_skill` tool, and the layer with its handler.
 *
 * `R` is the services the skills' instructions need, which the layer requires.
 *
 * @category models
 * @since 0.4.0
 */
export interface Toolkit<R = never> extends AiToolkit.Toolkit<{ readonly load_skill: LoadSkill }> {
  /** The handler of `load_skill`, which resolves the instructions of these skills. */
  readonly layer: Layer.Layer<Tool.Handler<"load_skill">, never, R>
}

const catalog = (skills: ReadonlyArray<Skill<unknown>>): string =>
  [
    "Load a skill, a playbook for a kind of task, by name, and follow it for the rest of the task. When one matches what you're doing, load it in the same step as your first lookups, not in a step of its own.",
    "",
    "Skills:",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`)
  ].join("\n")

function toolkitOf<const Skills extends ReadonlyArray<Skill<unknown>>>(
  skills: Skills
): Toolkit<Services<Skills[number]>>
// The overload states what the layer requires: the services of these skills' instructions.
function toolkitOf(skills: ReadonlyArray<Skill<unknown>>): Toolkit<unknown> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const tools = AiToolkit.make(loadSkill(catalog(skills)))

  const layer = tools.toLayer(
    Effect.gen(function* () {
      const context = yield* Effect.context<unknown>()

      return {
        load_skill: Effect.fnUntraced(function* ({ name }) {
          const skill = byName.get(name)

          if (skill === undefined) {
            return yield* ToolFailure.fail(
              `No skill named ${name}. The skills are: ${skills.map((known) => known.name).join(", ")}.`
            )
          }

          const resolved = yield* Instructions.resolve(skill.instructions).pipe(Effect.provideContext(context))

          return resolved.text
        })
      }
    })
  )

  return Object.assign(tools, { layer })
}

/**
 * Creates a toolkit from a list of skills: the `load_skill` tool, whose description lists each
 * skill's name and when to use it, and its handler's `layer`.
 *
 * **Details**
 *
 * Merge the toolkit into a loop's own with `Toolkit.merge`, and provide its `layer`, which requires
 * the services the skills' instructions need. The model loads a skill by name; a name that isn't
 * in the list is a failure the model reads, with the names there are.
 *
 * The handler resolves only the skills of its own list. To offer each user the skills they may
 * use, build the toolkit in the turn from that user's list, and provide its layer to the loop's
 * stream (`Stream.provide(skills.layer)`): building one does no work.
 *
 * **Example** (Giving an assistant its playbooks)
 *
 * ```ts
 * import { Skill } from "effect-assistant"
 * import * as Layer from "effect/Layer"
 * import * as Toolkit from "effect/ai/Toolkit"
 *
 * const AssistantSkills = Skill.toolkit([orderingCampaigns, sharingAssets])
 *
 * const MyAssistantLive = MyAssistant.toLayer((turn) =>
 *   turn.loop({ instructions, toolkit: Toolkit.merge(MyTools, AssistantSkills) })
 * ).pipe(Layer.provide([MyToolsLive, AssistantSkills.layer]))
 * ```
 *
 * **Example** (Offering each user the skills their role allows)
 *
 * ```ts
 * import { Skill } from "effect-assistant"
 * import * as Effect from "effect/Effect"
 * import * as Stream from "effect/Stream"
 * import * as Toolkit from "effect/ai/Toolkit"
 *
 * const MyAssistantLive = MyAssistant.toLayer((turn) =>
 *   Stream.unwrap(
 *     Effect.map(roleOf(turn.chatId), (role) => {
 *       const skills = Skill.toolkit(allSkills.filter((skill) => allowed(role, skill)))
 *
 *       return turn
 *         .loop({ instructions, toolkit: Toolkit.merge(MyTools, skills) })
 *         .pipe(Stream.provide(skills.layer))
 *     })
 *   )
 * )
 * ```
 *
 * @category constructors
 * @since 0.4.0
 */
export const toolkit: <const Skills extends ReadonlyArray<Skill<unknown>>>(
  skills: Skills
) => Toolkit<Services<Skills[number]>> = toolkitOf
