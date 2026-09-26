/**
 * The tools every assistant has: `send_user_message` and `wait`.
 *
 * @since 0.1.0
 * @internal
 */
import type * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as AssistantEvent from "../AssistantEvent.ts"
import { AssistantChat } from "../AssistantChat.ts"
import type * as BlockKit from "../BlockKit.ts"
import * as Uuid from "./uuid.ts"

const waitToolName = "wait"

/** @internal */
export const sendUserMessageName = "send_user_message"

/** @internal */
export const wait = Tool.make({
  name: waitToolName,
  description:
    "End your turn and wait for the next message or update, when you have nothing more to do right now and no message to send (otherwise set wait on send_user_message).",
  inputSchema: Tool.noInput,
  run: () => Effect.succeed("waiting")
})

const description =
  "Send the user a chat message. It's the only way they see anything you write: text outside it is private to you."

const Wait = Schema.Boolean.annotate({
  description:
    "true when this is your last message for now: your turn ends with it, as with the wait tool. false when you keep working after it."
})

const endsWithMessage = Schema.decodeOption(Schema.fromJsonString(Schema.Struct({ wait: Schema.Literal(true) })))

/**
 * Whether a tool call ends the turn: `wait`, or a message sent with
 * `wait: true`.
 *
 * @internal
 */
export const endsTurn = (call: Items.ToolCall): boolean =>
  call.name === waitToolName || (call.name === sendUserMessageName && Option.isSome(endsWithMessage(call.arguments)))

const append = (message: AssistantEvent.AssistantMessage) => AssistantChat.use((chat) => chat.append([message]))

const plainMessage = Tool.make({
  name: sendUserMessageName,
  description,
  inputSchema: Schema.Struct({ text: Schema.String, wait: Wait }),
  run: Effect.fn(function* ({ text }: { readonly text: string }) {
    yield* append(AssistantEvent.AssistantMessage.make({ id: yield* Uuid.random, text }))

    return "sent"
  })
})

interface BlockInput {
  readonly kind: string
  readonly props: unknown
}

/**
 * Returns `send_user_message`, taking an optional block from the kit when
 * there is one.
 *
 * @internal
 */
export const sendUserMessage = (kit: BlockKit.BlockKit | undefined) => {
  if (kit === undefined || kit.blocks.length === 0) return plainMessage

  const catalog = kit.blocks.map((block) => `- ${block.kind}: ${block.description}`).join("\n")
  const kinds = kit.blocks.map((block) => block.kind)

  // Props are checked against their kind's schema in `run`; the model sees every kind's in the input schema.
  const Input = Schema.Struct({
    text: Schema.String,
    wait: Wait,
    block: Schema.optional(
      Schema.Struct({
        kind: Schema.Literals(kinds),
        props: Schema.Union(kit.blocks.map((block) => block.props))
      })
    ),
    closes: Schema.optional(Schema.Array(Schema.String)).annotate({
      description:
        "Ids of your earlier messages whose block the user just answered by typing instead of using it. Those blocks close. Leave it out otherwise: a block stays open when the user talks about something else."
    })
  })

  const checkProps = (block: BlockInput) => {
    const props = kit.byKind.get(block.kind)?.props

    return props !== undefined && Option.isSome(Schema.decodeUnknownOption(props)(block.props))
  }

  return Tool.make({
    name: sendUserMessageName,
    description: `${description}
You can add a block to show UI with the message, e.g. a few options to pick from or a yes/no, when that makes answering easier than typing. Plain text is fine too. Using it sends you an <answer>; the user may also just type their answer instead, and then you pass that message's id in closes.
Blocks:
${catalog}`,
    inputSchema: Input,
    run: Effect.fn(function* ({ text, block, closes }: typeof Input.Type) {
      const id = yield* Uuid.random
      const closed = closes === undefined || closes.length === 0 ? {} : { closes }

      if (block === undefined) {
        yield* append(AssistantEvent.AssistantMessage.make({ id, text, ...closed }))

        return "sent"
      }

      if (!checkProps(block)) return yield* Tool.fail(`Those props don't fit a ${block.kind} block.`)

      yield* append(
        AssistantEvent.AssistantMessage.make({ id, text, block: AssistantEvent.MessageBlock.make(block), ...closed })
      )

      return `sent as message ${id}`
    })
  })
}
