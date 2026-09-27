/**
 * The message the assistant is writing, while the model writes it: how a
 * turn's loop tells the chat's live subscribers, and its text from params
 * that are still being written.
 *
 * @since 0.1.0
 * @internal
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as AssistantEvent from "../AssistantEvent.ts"

/**
 * Where a turn's loop sends what the assistant is composing: the chat's live
 * subscribers. Outside a turn (a specialist's run, a loop of the app's own)
 * it goes nowhere.
 *
 * @internal
 */
export const Composer = Context.Reference<(composing: AssistantEvent.Composing) => Effect.Effect<void>>(
  "effect-assistant/Composer",
  { defaultValue: () => () => Effect.void }
)

const decodeString = Schema.decodeOption(Schema.fromJsonString(Schema.String))

/** A string in JSON that may be cut off: where the JSON goes on after it, and its content as far as it's whole. */
interface PartialString {
  readonly next: number
  readonly value: string
}

/** Reads the string whose content starts at `start`. */
function readString(json: string, start: number): PartialString {
  let i = start
  let whole = start

  while (i < json.length && json[i] !== '"') {
    i += json[i] !== "\\" ? 1 : json[i + 1] === "u" ? 6 : 2

    if (i <= json.length) whole = i
  }

  return { next: i + 1, value: Option.getOrElse(decodeString(`"${json.slice(start, whole)}"`), () => "") }
}

/**
 * The top-level `text` string of a JSON object the model is still writing,
 * as far as it's written: `undefined` before the model started it. Never
 * fails: JSON cut off anywhere, even mid-escape, reads as what's whole.
 *
 * @internal
 */
export function partialText(json: string): string | undefined {
  let depth = 0
  let atKey = false
  let key: string | undefined
  let i = 0

  while (i < json.length) {
    const char = json[i]

    if (char === '"') {
      const string = readString(json, i + 1)

      if (depth === 1 && atKey) key = string.value
      else if (depth === 1 && key === "text") return string.value

      i = string.next
      continue
    }

    if (char === "{" || char === "[") depth++
    else if (char === "}" || char === "]") depth--

    if (depth === 1 && (char === "{" || char === ",")) atKey = true
    else if (depth === 1 && char === ":") atKey = false

    i++
  }

  return undefined
}
