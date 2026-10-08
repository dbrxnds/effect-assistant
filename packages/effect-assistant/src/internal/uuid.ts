/**
 * UUIDs for ids: random ones from Effect's `Random`, and ones derived from a
 * key.
 */
import * as Effect from "effect/Effect"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"

/** Schema for a UUID string. */
export const Uuid = Schema.String.check(Schema.isUUID())

const hex = (bytes: ReadonlyArray<number>): string => {
  const digits = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")

  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`
}

/** Sets the version nibble and the RFC 9562 variant bits. */
const format = (bytes: ReadonlyArray<number>, version: number): string => {
  const out = [...bytes]

  out[6] = ((out[6] ?? 0) & 0x0f) | (version << 4)
  out[8] = ((out[8] ?? 0) & 0x3f) | 0x80

  return hex(out)
}

/**
 * A random UUID (version 4), from the `Random` service: seed it in tests for
 * the same ids every run.
 */
export const make: Effect.Effect<string> = Effect.gen(function* () {
  const bytes = yield* Effect.forEach(Array.from({ length: 16 }), () => Random.nextIntBetween(0, 255))

  return format(bytes, 4)
})

/** 32-bit FNV-1a of the key, seeded per round. */
const fnv1a = (key: string, round: number): number => {
  let hash = 0x811c9dc5 ^ round

  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193)

  return hash >>> 0
}

/**
 * A UUID (version 8, custom) derived from a key: the same key gives the same
 * UUID. Not a secret, only unlikely to collide: four 32-bit FNV-1a hashes.
 */
export const fromKey = (key: string): string =>
  format(
    [0, 1, 2, 3].flatMap((round) => {
      const hash = fnv1a(key, round)

      return [hash >>> 24, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff]
    }),
    8
  )
