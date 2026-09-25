/**
 * The tools every assistant has: `send_user_message` and `wait`.
 *
 * @since 0.1.0
 * @internal
 */
import * as Tool from "@effect-uai/core/Tool"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { nanoid } from "nanoid"
import * as AssistantEvent from "../AssistantEvent.ts"
import { AssistantTurn } from "../AssistantTurn.ts"
import type * as BlockKit from "../BlockKit.ts"
import { ChatLog } from "../ChatLog.ts"

/**
 * Calling a tool with this name ends the turn once the step's tool calls have
 * run.
 *
 * @internal
 */
export const waitToolName = "wait"

/** @internal */
export const wait = Tool.make({
  name: waitToolName,
  description:
    "End your turn and wait for the next message or fact. Call it when you have nothing more to do right now, in the same step as your last send_user_message.",
  inputSchema: Tool.noInput,
  run: () => Effect.succeed("waiting")
})

const description = "Send a chat message to the user. This is the only way the user sees anything you write."

const append = Effect.fn(function* (message: AssistantEvent.AssistantMessage) {
  const turn = yield* AssistantTurn
  const log = yield* ChatLog
  yield* log.append(turn.chatId, [message])
})

const plainMessage = Tool.make({
  name: "send_user_message",
  description,
  inputSchema: Schema.Struct({ text: Schema.String }),
  run: ({ text }) => append(AssistantEvent.AssistantMessage.make({ id: nanoid(), text })).pipe(Effect.as("sent"))
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
  // SAFETY: a kit always has at least one block here (checked above).
  const kinds = kit.blocks.map((block) => block.kind) as [string, ...Array<string>]

  // SAFETY: as above. Block props are checked against their kind in `run`, so
  // here they only need to decode to something.
  const propsSchemas = kit.blocks.map((block) => block.props) as [
    Schema.Codec<unknown, unknown>,
    ...Array<Schema.Codec<unknown, unknown>>
  ]

  const Input = Schema.Struct({
    text: Schema.String,
    block: Schema.optional(
      Schema.Struct({
        kind: Schema.Literals(kinds),
        props: propsSchemas.length === 1 ? propsSchemas[0] : Schema.Union(propsSchemas)
      })
    ),
    closes: Schema.optional(Schema.Array(Schema.String)).annotate({
      description:
        "Ids of your earlier messages whose block the user just answered by typing instead of using it. Those blocks close. Leave it out otherwise: a block stays open when the user talks about something else."
    })
  })

  const propsByKind = new Map(kinds.map((kind, i) => [kind, propsSchemas[i]!]))

  const checkProps = (block: BlockInput) => {
    const props = propsByKind.get(block.kind)

    return props !== undefined && Option.isSome(Schema.decodeUnknownOption(props)(block.props))
  }

  return Tool.make({
    name: "send_user_message",
    description: `${description}
You can add a block to show UI with the message, e.g. a few options to pick from or a yes/no, when that makes answering easier than typing. Plain text is fine too. Using it sends you an <answer>; the user may also just type their answer instead, and then you pass that message's id in closes.
Blocks:
${catalog}`,
    inputSchema: Input,
    run: Effect.fn(function* ({ text, block, closes }: typeof Input.Type) {
      const id = nanoid()
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
