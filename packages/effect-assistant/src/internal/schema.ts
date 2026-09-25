/**
 * @since 0.1.0
 * @internal
 */
import type * as Schema from "effect/Schema"

/**
 * Drops a codec's decoding and encoding services from its type.
 *
 * Use it for schemas that declare `unknown` services but need none at
 * runtime, such as effect-uai's history items, which are plain JSON.
 *
 * @internal
 */
export const withoutServices = <T, E>(schema: Schema.Codec<T, E, unknown, unknown>): Schema.Codec<T, E> =>
  // SAFETY: callers only pass codecs that need no services at runtime.
  schema as Schema.Codec<T, E>
