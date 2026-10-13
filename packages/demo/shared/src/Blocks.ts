/**
 * The UI blocks Acme can put in its messages. Shared, so the web app renders
 * exactly the blocks the assistant may send.
 *
 * @since 0.1.0
 */
import * as Block from "effect-assistant/Block"
import * as BlockKit from "effect-assistant/BlockKit"
import * as Schema from "effect/Schema"

/**
 * Buttons for picking one option.
 *
 * @category blocks
 * @since 0.1.0
 */
export const ChooseOne = Block.make("choose_one", {
  description: "Buttons for picking one of a few options, e.g. which campaign product. Keep options short.",
  props: Schema.Struct({ options: Schema.Array(Schema.String) }),
  answer: Schema.Struct({ choice: Schema.String })
})

/**
 * A small input for a short answer.
 *
 * @category blocks
 * @since 0.1.0
 */
export const TextInput = Block.make("text_input", {
  description:
    "A small input for a short free-form answer, e.g. who a campaign should reach or a budget. One question per input.",
  props: Schema.Struct({
    placeholder: Schema.String.annotate({ description: 'e.g. "Parents in Austin"' })
  }),
  answer: Schema.Struct({ value: Schema.String })
})

/**
 * Every block Acme can use: a choice or a short answer goes back to Acme as
 * the block's answer. Orders and campaigns are tool calls the user approves
 * (`Approvals.ts`).
 *
 * @category blocks
 * @since 0.1.0
 */
export const Blocks = BlockKit.make([ChooseOne, TextInput])
