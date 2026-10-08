/** The tools every assistant has: `send_user_message` and `wait`. */
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { AssistantChat } from "../AssistantChat.ts"
import * as AssistantEvent from "../AssistantEvent.ts"
import type * as AssistantLoop from "../AssistantLoop.ts"
import { AssistantToolCall } from "../AssistantToolCall.ts"
import * as BlockKit from "../BlockKit.ts"
import * as Decision from "../Decision.ts"
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

/**
 * Whether a tool call ends the turn: `wait`, or a message sent with
 * `wait: true`.
 */
export const isTurnEnding = (call: AssistantEvent.ToolCallPart): boolean =>
  call.name === waitToolName || (call.name === sendUserMessageName && Option.isSome(endsWithMessage(call.params)))

/**
 * The message's id, from the call: a call cut off by a crash runs again with
 * the same id, and finds its message already sent.
 */
const messageId = AssistantToolCall.useSync((call) => Uuid.fromKey(`message:${call.callId}`))

const append = Effect.fnUntraced(function* (message: AssistantEvent.AssistantMessage) {
  const chat = yield* AssistantChat
  const entries = yield* chat.entries

  const sent = entries.some(
    ({ event }) =>
      AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "AssistantMessage") && event.id === message.id
  )

  if (!sent) yield* chat.append([message])
})

const PlainMessage = Tool.make(sendUserMessageName, {
  description,
  parameters: Schema.Struct({ text: Schema.String, wait: WaitFlag }),
  success: Schema.String,
  failure: ToolFailure.ToolFailure,
  dependencies: [AssistantChat, AssistantToolCall]
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

const decodeDecisionProps = Schema.decodeUnknownOption(Decision.Props)

/** A decision block asks only for decisions that wait for the user. */
const checkDecisions = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
  const states = Decision.fromEntries(yield* AssistantChat.use((chat) => chat.entries))
  const notWaiting = ids.filter((id) => states.get(id)?.outcome !== undefined || !states.has(id))

  if (notWaiting.length > 0) {
    return yield* ToolFailure.fail(
      `Not waiting for the user's decision: ${notWaiting.join(", ")}. Use the ids of decisions that wait for one.`,
      { kind: "not_waiting_for_decision" }
    )
  }
})

/**
 * A decision block closes when the user decides on it, not because the model
 * says so: the order it asks about would otherwise never be approved.
 */
const checkCloses = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
  const entries = yield* AssistantChat.use((chat) => chat.entries)
  const states = BlockKit.blockStates(entries)

  const waiting = ids.filter((id) =>
    entries.some(
      ({ event }) =>
        AssistantEvent.isLibraryEvent(event) &&
        Predicate.isTagged(event, "AssistantMessage") &&
        event.id === id &&
        event.block?.kind === Decision.kind &&
        states.get(id)?.open === true
    )
  )

  if (waiting.length > 0) {
    return yield* ToolFailure.fail(
      `${waiting.join(", ")} asks for a decision that still waits for the user: only their answer in the block closes it. Send the message again without ${waiting.length === 1 ? "that id" : "those ids"} in closes.`,
      { kind: "decision_waiting" }
    )
  }
})

/** `send_user_message` with an optional block from the kit, and `wait`. */
const blockTools = Effect.fnUntraced(function* (kit: BlockKit.BlockKit) {
  const catalog = kit.blocks.map((block) => `- ${block.kind}: ${block.description}`).join("\n")
  const kinds = kit.blocks.map((block) => block.kind)

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
          props: Schema.Union(kit.blocks.map((block) => block.props))
        })
      ),
      closes: Schema.optional(Schema.Array(Schema.String)).annotate({
        description:
          "Ids of your earlier messages whose block the user just answered by typing instead of using it. Those blocks close. Leave it out otherwise: a block stays open when the user talks about something else. A decision block never closes this way: only the user's answer in it decides."
      })
    }),
    success: Schema.String,
    failure: ToolFailure.ToolFailure,
    dependencies: [AssistantChat, AssistantToolCall]
  })

  const BlockTools = Toolkit.make(BlockMessage, Wait)

  const handlers = yield* BlockTools.toHandlers({
    wait: () => Effect.succeed("waiting"),
    send_user_message: Effect.fnUntraced(function* ({ text, block, closes }) {
      if (text.trim() === "") {
        return yield* ToolFailure.fail(
          "The message has no text: the user sees only what you send here, and a block alone is an empty bubble. Send it again with the words they should read (a short lead-in for the block).",
          { kind: "empty_message" }
        )
      }

      const id = yield* messageId
      const closed = closes === undefined || closes.length === 0 ? {} : { closes }

      if (closes !== undefined && closes.length > 0) yield* checkCloses(closes)

      if (block === undefined) {
        yield* append(AssistantEvent.AssistantMessage.make({ id, text, ...closed }))

        return "sent"
      }

      const props = kit.byKind.get(block.kind)?.props

      if (props === undefined || Option.isNone(Schema.decodeUnknownOption(props)(block.props))) {
        return yield* ToolFailure.fail(`Those props don't fit a ${block.kind} block.`)
      }

      if (block.kind === Decision.kind) {
        yield* checkDecisions(
          Option.match(decodeDecisionProps(block.props), {
            onNone: () => [],
            onSome: (decoded) => decoded.decisionIds
          })
        )
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

/**
 * `send_user_message`, taking an optional block from the kit when there is
 * one, and `wait`.
 */
export const makeMessaging: (kit: BlockKit.BlockKit | undefined) => Effect.Effect<AssistantLoop.Tools<AssistantChat>> =
  Effect.fnUntraced(function* (kit) {
    if (kit === undefined || kit.blocks.length === 0) {
      return Toolkits.fromWithHandler(yield* plainTools)
    }

    return Toolkits.fromWithHandler(yield* blockTools(kit))
  })
