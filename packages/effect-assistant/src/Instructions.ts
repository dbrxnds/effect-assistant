/**
 * Defines the instructions that tell an assistant, specialist, or skill what to do.
 *
 * Instructions are text, or an Effect that produces text, optionally with span attributes
 * (a {@link Resolved}). {@link resolve} turns them into a `Resolved`, and {@link protocol} is the
 * text a turn's loop needs the model to know.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"

/**
 * The text the model has to know for a turn's loop to work.
 *
 * **Details**
 *
 * It tells the model that it acts only through tool calls, that the user sees only what it sends
 * with `send_user_message`, to open work with a one-line message (`wait: false`) next to its first
 * calls and then deliver the result, that `wait` (or a last message with `wait: true`) ends the
 * turn, and that messages can arrive mid-turn. The rest, such as what a `<specialist>` block or an app's
 * event is, is in the tools' descriptions and in the history itself.
 *
 * `turn.instructions(text)` puts it before the text, and a custom loop on `AssistantLoop.run` can
 * use it too.
 *
 * @category utils
 * @since 0.1.0
 */
export const protocol = `Act only through tool calls. The user sees only the text you send with send_user_message, so the whole answer goes in it.
When answering needs tools, first send one short line naming your first step, with wait false, in the same step as that step's calls. That line isn't the answer: keep going until you've sent the result.
When you have nothing more to do, end your turn: wait true on your last message, or call wait.
Messages can arrive while you work: handle the newest, and don't repeat what you already said.`

/**
 * Represents the span attributes added to every model call made with a prompt.
 *
 * @category models
 * @since 0.1.0
 */
export type SpanAttributes = Readonly<Record<string, string | number | boolean>>

/**
 * Represents instructions resolved to text, with the span attributes to record them under.
 *
 * @category models
 * @since 0.1.0
 */
export interface Resolved {
  readonly text: string
  readonly attributes?: SpanAttributes | undefined
}

/**
 * Represents instructions as text, or as an Effect that produces the text (optionally with span
 * attributes).
 *
 * @category models
 * @since 0.1.0
 */
export type Instructions<R = never> = string | Effect.Effect<string | Resolved, never, R>

/**
 * Resolves instructions to their text and span attributes.
 *
 * @category utils
 * @since 0.1.0
 */
export const resolve = Effect.fn("Instructions.resolve")(function* <R = never>(instructions: Instructions<R>) {
  return Predicate.isString(instructions) ? { text: instructions } : toResolved(yield* instructions)
})

const toResolved = (resolved: string | Resolved): Resolved =>
  Predicate.isString(resolved) ? { text: resolved } : resolved
