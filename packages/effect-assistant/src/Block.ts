/**
 * Defines UI blocks that an assistant can put in a message.
 *
 * A block is a bit of UI for when a structured answer is easier than typing, such as options to
 * pick from, a yes or no, or a small input. The assistant fills in its `props`, and
 * using the block sends back a value typed by its `answer` schema.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as AssistantEvent from "./AssistantEvent.ts"
import * as InputId from "./InputId.ts"

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

/**
 * Returns the user's answer to a block on a message, as the input that records it.
 *
 * **Details**
 *
 * The value is encoded with the block's answer schema. The input's id is fixed per message, the
 * same one a client's `respond` uses (see `BlockKit.toClient`), so a block takes one answer however
 * often it's sent.
 *
 * **When to use it**
 *
 * For a block whose button calls your app's own API (the user acts, and your API does the work):
 * once the work is done, the API submits the block's answer itself. The block shows as answered
 * on the timeline, and a turn wakes and reads what the user did.
 *
 * **Example** (Recording an order the user placed from its block)
 *
 * ```ts
 * import { Block, type ChatId } from "effect-assistant"
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 *
 * const OrderCheckout = Block.make("order_checkout", {
 *   description: "An order ready to place, with a Place order button. Only the user places it.",
 *   props: Schema.Struct({ product: Schema.String, quantity: Schema.Int }),
 *   answer: Schema.Struct({ orderId: Schema.String })
 * })
 *
 * // Your API, behind the block's button.
 * const placeOrder = Effect.fn(function* (chatId: ChatId.ChatId, messageId: string, order: typeof OrderCheckout.props.Type) {
 *   const orderId = yield* placeOnce(`${chatId}:${messageId}`, order)
 *
 *   yield* MyAssistant.use((assistant) =>
 *     assistant.submit(chatId, Block.answer(OrderCheckout, { messageId, value: { orderId } }))
 *   )
 * })
 * ```
 *
 * @category constructors
 * @since 0.4.0
 */
export const answer = <Kind extends string, Props extends Codec, Answer extends Codec>(
  block: Block<Kind, Props, Answer>,
  options: {
    /** The id of the message the block is on. */
    readonly messageId: string
    /** The answer, in the block's answer schema. */
    readonly value: Answer["Type"]
  }
): AssistantEvent.BlockAnswer =>
  AssistantEvent.BlockAnswer.make({
    // A block takes one answer: the same id every time, so a second one is stored once.
    id: InputId.fromKey(`${options.messageId}:answer`),
    messageId: options.messageId,
    kind: block.kind,
    value:
      block.answer === undefined
        ? options.value
        : Schema.encodeUnknownSync(Schema.toCodecJson(block.answer))(options.value)
  })
