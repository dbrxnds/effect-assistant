/**
 * The `Instructions` module defines what an assistant, specialist, or skill is
 * told to do: text, optionally with span attributes (a {@link Resolved}).
 */
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"

/**
 * What the model has to know for a turn's loop to work: every step is a tool
 * call, `wait` (or a last message with `wait: true`) ends the turn, and
 * messages can arrive mid-turn. The rest (the user sees only
 * `send_user_message`, what a `<specialist>` or an app's event is) is in the
 * tools' descriptions and in the history itself.
 * `turn.instructions(text)` puts it before the text; a custom loop on
 * `AssistantLoop.run` can use it too.
 */
export const protocol = `Every step is a tool call. When you have nothing more to do right now, end your turn: set wait to true on your last send_user_message, or call wait if you have nothing to say.
The user sees only the text of what you send with send_user_message: anything else you write is never shown, so put the whole answer in the message, not next to it.
Messages and updates can arrive while you work: handle the newest one, and don't repeat what you already told the user.`

/** Span attributes added to every model call made with a prompt. */
export type SpanAttributes = Readonly<Record<string, string | number | boolean>>

/** Instructions with the span attributes to record them under. */
export interface Resolved {
  readonly text: string
  readonly attributes?: SpanAttributes | undefined
}

/** Text, or an Effect that produces it (optionally with span attributes). */
export type Instructions<R = never> = string | Effect.Effect<string | Resolved, never, R>

/** Resolves instructions to text and span attributes. */
export const resolve = Effect.fn("Instructions.resolve")(function* <R = never>(instructions: Instructions<R>) {
  return Predicate.isString(instructions) ? { text: instructions } : toResolved(yield* instructions)
})

const toResolved = (resolved: string | Resolved): Resolved =>
  Predicate.isString(resolved) ? { text: resolved } : resolved
