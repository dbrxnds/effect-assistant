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
 * It tells the model that every step is a tool call, that `wait` (or a last message with
 * `wait: true`) ends the turn, that the user sees only what it sends with `send_user_message`, and
 * that messages can arrive mid-turn. The rest, such as what a `<specialist>` block or an app's
 * event is, is in the tools' descriptions and in the history itself.
 *
 * `turn.instructions(text)` puts it before the text, and a custom loop on `AssistantLoop.run` can
 * use it too.
 *
 * @category utils
 * @since 0.1.0
 */
export const protocol = `Every step is a tool call. When you have nothing more to do right now, end your turn: set wait to true on your last send_user_message, or call wait if you have nothing to say.
The user sees only the text of what you send with send_user_message: anything else you write is never shown, so put the whole answer in the message, not next to it.
Messages and updates can arrive while you work: handle the newest one, and don't repeat what you already told the user.`

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
