/**
 * The `Block` module defines UI blocks: a bit of UI the assistant can put in a
 * message when a structured answer is easier than typing, such as options to
 * pick from, approve/deny, or a small input.
 *
 * A host defines a fixed catalog of blocks, shared by server and client (see
 * `BlockKit`). The assistant adds one to a message with
 * `send_user_message({ text, block: { kind, props } })`. Using it sends a
 * `BlockAnswer` input, shown in the block rather than as a message. A block is
 * only a shortcut: the user can always type instead, and the assistant reads either.
 *
 * **Example** (Defining blocks)
 *
 * ```ts
 * import * as Schema from "effect/Schema"
 * import { Block, BlockKit } from "effect-assistant"
 *
 * const ChooseOne = Block.make("choose_one", {
 *   description: "Buttons for picking one of a few options.",
 *   props: Schema.Struct({ options: Schema.Array(Schema.String) }),
 *   answer: Schema.Struct({ choice: Schema.String })
 * })
 *
 * const Confirm = Block.make("confirm", {
 *   description: "Approve / deny buttons for a yes-or-no decision.",
 *   props: Schema.Struct({ confirmLabel: Schema.String, denyLabel: Schema.String }),
 *   answer: Schema.Struct({ confirmed: Schema.Boolean })
 * })
 *
 * export const Blocks = BlockKit.make([ChooseOne, Confirm])
 * ```
 *
 * @since 0.1.0
 */
import type * as Schema from "effect/Schema"

/**
 * A kind of UI block.
 *
 * @category models
 * @since 0.1.0
 */
export interface Block<
  Kind extends string = string,
  Props extends Schema.Top = Schema.Top,
  Answer extends Schema.Top = Schema.Top
> {
  readonly kind: Kind
  /** When to use it. The assistant sees this. */
  readonly description: string
  /** What the assistant fills in. */
  readonly props: Props
  /** What using the block sends back. `undefined` for display-only cards. */
  readonly answer: Answer | undefined
}

/**
 * Any block, for generic constraints.
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
 * The assistant fills in `props`; the props schema is checked when it sends the
 * message. `answer` is what the client sends back when the block is used.
 * Leave it out for display-only cards.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <const Kind extends string, Props extends Schema.Top, Answer extends Schema.Top = Schema.Never>(
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
