/**
 * @since 0.1.0
 * @internal
 */
import { flow } from "effect/Function"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * Drops a codec's decoding and encoding services from its type.
 *
 * Use it for schemas that declare `unknown` services but need none at
 * runtime, such as effect-uai's history items, which are plain JSON.
 *
 * @internal
 */
export function withoutServices<T, E>(schema: Schema.Codec<T, E, unknown, unknown>): Schema.Codec<T, E>
// The overload states what callers get; the codec itself is returned as it is.
export function withoutServices(schema: Schema.Top): Schema.Top {
  return schema
}

const JsonText = Schema.fromJsonString(Schema.Unknown)

/**
 * A value as JSON text, for the model or a span. A value with no JSON form
 * (`undefined`, a cycle) is empty text rather than a defect.
 *
 * @internal
 */
export const toJsonText = flow(
  Schema.encodeUnknownOption(JsonText),
  Option.getOrElse(() => "")
)

/**
 * Whether text is valid JSON.
 *
 * @internal
 */
export const isJsonText = (text: string): boolean => Option.isSome(Schema.decodeOption(JsonText)(text))
