/**
 * The `Instructions` module defines what an assistant, specialist, or skill is
 * told to do: text, optionally with span attributes (a {@link Resolved}).
 *
 * In a handler, instructions are just a value the handler computes: fetch
 * the current version from a prompt manager, or tailor it to the user. A
 * resolved prompt's span attributes (such as its name and version) are added
 * to every model call it is used for. A skill's instructions can also be an
 * Effect, resolved each time the skill is loaded.
 *
 * **Example** (Instructions from a prompt service)
 *
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { MyAssistant } from "./MyAssistant.ts"
 * import { Prompts } from "./Prompts.ts" // your service, provided by a layer
 *
 * const MyAssistantLive = MyAssistant.toLayer(Effect.gen(function*() {
 *   const prompts = yield* Prompts
 *
 *   return Effect.fn(function*(turn: Assistant.Turn) {
 *     return turn.loop({ model: "claude-sonnet-5", instructions: yield* prompts.get("my-assistant") })
 *   })
 * }))
 * ```
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"

/**
 * Span attributes added to every model call made with a prompt.
 *
 * @category models
 * @since 0.1.0
 */
export type SpanAttributes = Readonly<Record<string, string | number | boolean>>

/**
 * Instructions with the span attributes to record them under.
 *
 * @category models
 * @since 0.1.0
 */
export interface Resolved {
  readonly text: string
  readonly attributes?: SpanAttributes | undefined
}

/**
 * Text, or an Effect that produces it (optionally with span attributes).
 *
 * **Gotchas**
 *
 * The Effect can't fail. If it reads from a service that can be down, fall
 * back to fixed text inside it.
 *
 * @category models
 * @since 0.1.0
 */
export type Instructions<R = never> = string | Effect.Effect<string | Resolved, never, R>

/**
 * Resolves instructions to text and span attributes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolve = <R = never>(instructions: Instructions<R>): Effect.Effect<Resolved, never, R> =>
  Predicate.isString(instructions) ? Effect.succeed({ text: instructions }) : Effect.map(instructions, toResolved)

const toResolved = (resolved: string | Resolved): Resolved =>
  Predicate.isString(resolved) ? { text: resolved } : resolved
