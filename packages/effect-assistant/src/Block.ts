/**
 * The `Block` module defines UI blocks: a bit of UI the assistant can put in a
 * message when a structured answer is easier than typing, such as options to
 * pick from, approve/deny, or a small input.
 */
import type * as Schema from "effect/Schema"

/**
 * A schema a block's props or answer can use: any codec that needs no
 * services, since the client decodes and encodes with it too.
 */
export type Codec = Schema.Codec<any, any>

/** A kind of UI block. */
export interface Block<Kind extends string = string, Props extends Codec = Codec, Answer extends Codec = Codec> {
  readonly kind: Kind
  /** When to use it. The assistant sees this. */
  readonly description: string
  /** What the assistant fills in. */
  readonly props: Props
  /** What using the block sends back. `undefined` for display-only cards. */
  readonly answer: Answer | undefined
}

/** Any block, for generic constraints. */
export type Any = Block

/** Creates a block. */
export const make = <const Kind extends string, Props extends Codec, Answer extends Codec = Schema.Never>(
  kind: Kind,
  options: {
    readonly description: string
    readonly props: Props
    readonly answer?: Answer | undefined
  }
): Block<Kind, Props, Answer> => ({
  kind,
  description: options.description,
  props: options.props,
  answer: options.answer
})
