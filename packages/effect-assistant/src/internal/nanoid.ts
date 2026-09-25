/**
 * @since 0.1.0
 * @internal
 */
import * as Schema from "effect/Schema"
import { nanoid } from "nanoid"

/**
 * nanoid's default alphabet (`A-Za-z0-9_-`) at the default length (21). The
 * id modules put their prefix on a template literal around it.
 *
 * @internal
 */
export const Nanoid = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{21}$/))

/** @internal */
export const make = (): string => nanoid()

const alphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"

/**
 * A nanoid-shaped id derived from a key: the same key gives the same id.
 * Not a secret, only unlikely to collide: five 32-bit FNV-1a hashes of the key.
 *
 * @internal
 */
export const fromKey = (key: string): string => {
  let out = ""

  for (let round = 0; out.length < 21; round++) {
    // 32-bit FNV-1a of the key and the round, six characters of it at a time.
    let hash = 0x811c9dc5 ^ round

    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }

    for (let i = 0; i < 5 && out.length < 21; i++) out += alphabet[(hash >>> (i * 6)) & 63]
  }

  return out
}
