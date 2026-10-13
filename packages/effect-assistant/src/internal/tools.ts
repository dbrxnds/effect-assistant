import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as AssistantEvent from "../AssistantEvent.ts"
import { AssistantToolCall } from "../AssistantToolCall.ts"
import * as Block from "../Block.ts"
import type * as BlockKit from "../BlockKit.ts"
import { CurrentChat } from "../CurrentChat.ts"
import * as ToolFailure from "../ToolFailure.ts"
import * as Toolkits from "./toolkit.ts"
import * as Uuid from "./uuid.ts"

/** @internal */
export const waitToolName = "wait"

/** @internal */
export const sendUserMessageName = "send_user_message"

const Wait = Tool.make(waitToolName, {
  description:
    "End your turn and wait for the next message or update, when you have nothing more to do right now and no message to send (otherwise set wait on send_user_message).",
  success: Schema.String
})

const description =
  "Send the user a chat message. It's the only way they see anything you write: text outside it is private to you."

const WaitFlag = Schema.Boolean.annotate({
  description:
    "true when this is your last message for now: your turn ends with it, as with the wait tool. false when you keep working after it."
})

const endsWithMessage = Schema.decodeUnknownOption(Schema.Struct({ wait: Schema.Literal(true) }))

const messageText = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))

// A message the user reads: the call's text isn't empty.
/** @internal */
export const isUserMessage = (call: AssistantEvent.ToolCallPart): boolean =>
  call.name === sendUserMessageName && Option.exists(messageText(call.params), ({ text }) => text.trim() !== "")

/** @internal */
export const isTurnEnding = (call: AssistantEvent.ToolCallPart): boolean =>
  call.name === waitToolName || (call.name === sendUserMessageName && Option.isSome(endsWithMessage(call.params)))

// From the call: a call cut off by a crash runs again with the same id, and finds its message already sent.
const messageId = AssistantToolCall.useSync((call) => Uuid.fromKey(`message:${call.callId}`))

const append = Effect.fnUntraced(function* (message: AssistantEvent.AssistantMessage) {
  const chat = yield* CurrentChat
  const entries = yield* chat.entries

  const sent = entries.some(
    ({ event }) =>
      AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "AssistantMessage") && event.id === message.id
  )

  if (!sent) yield* chat.append(message)
})

const PlainMessage = Tool.make(sendUserMessageName, {
  description,
  parameters: Schema.Struct({ text: Schema.String, wait: WaitFlag }),
  success: Schema.String,
  failure: ToolFailure.ToolFailure,
  dependencies: [CurrentChat, AssistantToolCall]
})

const PlainTools = Toolkit.make(PlainMessage, Wait)

const plainHandlers = PlainTools.toHandlers({
  wait: () => Effect.succeed("waiting"),
  send_user_message: Effect.fnUntraced(function* ({ text }) {
    yield* append(AssistantEvent.AssistantMessage.make({ id: yield* messageId, text }))

    return "sent"
  })
})

const plainTools = Effect.gen(function* () {
  return yield* Effect.provideContext(PlainTools, yield* plainHandlers)
})

/** @internal */
export const toolResultKind = "tool_result"

const ToolResultRef = Schema.Struct({
  resultId: Schema.String.annotate({ description: "The resultId of the tool result to show." })
})

const decodeRef = Schema.decodeUnknownOption(ToolResultRef)

// The latest successful result with that id, of a tool the kit shows.
const shownResult = Effect.fnUntraced(function* (resultId: string, shown: ReadonlySet<string>) {
  const entries = yield* (yield* CurrentChat).entries

  const result = entries
    .flatMap(({ event }) =>
      AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "ToolResult") && event.resultId === resultId
        ? [event]
        : []
    )
    .at(-1)

  if (result === undefined || result.outcome === "failure") {
    return yield* ToolFailure.fail(
      `No tool result ${resultId} to show: pass the resultId of a result you got in this chat.`,
      { reason: "ResultNotFound" }
    )
  }

  if (!shown.has(result.tool)) {
    return yield* ToolFailure.fail(`${result.tool} results can't be shown.`, { reason: "ResultNotShown" })
  }

  return result
})

const blockTools = Effect.fnUntraced(function* (kit: BlockKit.BlockKit) {
  const asked = kit.blocks.filter((block) => !Block.isToolResult(block))
  const shown = new Set(kit.blocks.flatMap((block) => (Block.isToolResult(block) ? [block.tool.name] : [])))

  const catalog = [
    ...asked.map((block) => `- ${block.kind}: ${block.description}`),
    ...(shown.size === 0
      ? []
      : [
          `- ${toolResultKind}: a tool's result, shown the way the app draws it (found items as cards, a download as a button). Results you can show have a resultId: pass it as the props. From: ${[...shown].join(", ")}.`
        ])
  ].join("\n")

  const kinds = [...asked.map((block) => block.kind), ...(shown.size === 0 ? [] : [toolResultKind])]
  const props = [...asked.map((block) => block.props), ...(shown.size === 0 ? [] : [ToolResultRef])]

  const BlockMessage = Tool.make(sendUserMessageName, {
    description: `${description}
You can add a block to show UI with the message, e.g. a few options to pick from or a yes/no, when that makes answering easier than typing. Plain text is fine too. Using it sends you an <answer>; the user may also just type their answer instead, and then you pass that message's id in closes.
Blocks:
${catalog}`,
    // Props are checked against their kind's schema by the handler; the model sees every kind's in the parameters.
    parameters: Schema.Struct({
      text: Schema.String,
      wait: WaitFlag,
      block: Schema.optional(
        Schema.Struct({
          kind: Schema.Literals(kinds),
          props: Schema.Union(props)
        })
      ),
      closes: Schema.optional(Schema.Array(Schema.String)).annotate({
        description:
          "Ids of your earlier messages whose block the user just answered by typing instead of using it. Those blocks close. Leave it out otherwise: a block stays open when the user talks about something else."
      })
    }),
    success: Schema.String,
    failure: ToolFailure.ToolFailure,
    dependencies: [CurrentChat, AssistantToolCall]
  })

  const BlockTools = Toolkit.make(BlockMessage, Wait)

  const handlers = yield* BlockTools.toHandlers({
    wait: () => Effect.succeed("waiting"),
    send_user_message: Effect.fnUntraced(function* ({ text, block, closes }) {
      if (text.trim() === "") {
        return yield* ToolFailure.fail(
          "The message has no text: the user sees only what you send here, and a block alone is an empty bubble. Send it again with the words they should read (a short lead-in for the block).",
          { reason: "EmptyMessage" }
        )
      }

      const id = yield* messageId
      const closed = closes === undefined || closes.length === 0 ? {} : { closes }

      if (block === undefined) {
        yield* append(AssistantEvent.AssistantMessage.make({ id, text, ...closed }))

        return "sent"
      }

      if (block.kind === toolResultKind) {
        const ref = decodeRef(block.props)

        if (Option.isNone(ref)) {
          return yield* ToolFailure.fail(`A ${toolResultKind} block's props are { resultId }.`)
        }

        const result = yield* shownResult(ref.value.resultId, shown)

        yield* append(
          AssistantEvent.AssistantMessage.make({
            id,
            text,
            block: AssistantEvent.MessageBlock.make({ kind: result.tool, props: {}, resultId: ref.value.resultId }),
            ...closed
          })
        )

        return `sent as message ${id}`
      }

      const schema = kit.byKind.get(block.kind)?.props

      if (schema === undefined || Option.isNone(Schema.decodeUnknownOption(schema)(block.props))) {
        return yield* ToolFailure.fail(`Those props don't fit a ${block.kind} block.`)
      }

      yield* append(
        AssistantEvent.AssistantMessage.make({
          id,
          text,
          block: AssistantEvent.MessageBlock.make(block),
          ...closed
        })
      )

      return `sent as message ${id}`
    })
  })

  return yield* Effect.provideContext(BlockTools, handlers)
})

/** @internal */
export const makeMessaging: (kit: BlockKit.BlockKit | undefined) => Effect.Effect<Toolkits.Tools<CurrentChat>> =
  Effect.fnUntraced(function* (kit) {
    if (kit === undefined || kit.blocks.length === 0) {
      return Toolkits.fromWithHandler(yield* plainTools)
    }

    return Toolkits.fromWithHandler(yield* blockTools(kit))
  })
