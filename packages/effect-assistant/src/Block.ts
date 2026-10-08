/**
 * Defines UI blocks that an assistant can put in a message.
 *
 * A block is a bit of UI for when a structured answer is easier than typing, such as options to
 * pick from, approve and deny buttons, or a small input. The assistant fills in its `props`, and
 * using the block sends back a value typed by its `answer` schema.
 *
 * @since 0.1.0
 */
import type * as Schema from "effect/Schema"

/**
 * Schema that a block's props or answer can use.
 *
 * It is any codec that needs no services, since the client decodes and encodes with it too.
 *
 * @category utility types
 * @since 0.1.0
 */
export type Codec = Schema.Codec<any, any>

/**
 * Represents a kind of UI block.
 *
 * @category models
 * @since 0.1.0
 */
export interface Block<Kind extends string = string, Props extends Codec = Codec, Answer extends Codec = Codec> {
  readonly kind: Kind
  /** When to use the block. The assistant sees this. */
  readonly description: string
  /** The props the assistant fills in. */
  readonly props: Props
  /** What using the block sends back, or `undefined` for a display-only card. */
  readonly answer: Answer | undefined
}

/**
 * Represents any block, for generic constraints.
 *
 * @category utility types
 * @since 0.1.0
 */
export type Any = Block

/**
 * Creates a block.
 *
 * **Details**
 *
 * A block without an `answer` schema is a display-only card. Put the block in the assistant's
 * `BlockKit` so the assistant can use it.
 *
 * **Example** (Defining a block with options to pick from)
 *
 * ```ts
 * import { Assistant, Block, BlockKit } from "effect-assistant"
 * import * as Schema from "effect/Schema"
 *
 * const PickOne = Block.make("pick_one", {
 *   description: "Options to pick from, when the user chooses between a few.",
 *   props: Schema.Struct({ options: Schema.Array(Schema.String) }),
 *   answer: Schema.Struct({ picked: Schema.String })
 * })
 *
 * export const MyAssistant = Assistant.make("my-assistant", { blocks: BlockKit.make([PickOne]) })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
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
