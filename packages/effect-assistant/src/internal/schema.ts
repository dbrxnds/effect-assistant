/**
 * @since 0.1.0
 * @internal
 */
import { flow } from "effect/Function"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

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

const decodeJsonText = Schema.decodeOption(Schema.fromJsonString(Schema.Json))

/**
 * A value in its JSON form, as `JSON.stringify` writes it (a `Date` as its
 * ISO string, a class as its fields), or `null` when it has none.
 *
 * @internal
 */
export const toJson = flow(
  Schema.encodeUnknownOption(JsonText),
  Option.flatMap(decodeJsonText),
  Option.getOrElse((): Schema.Json => null)
)
