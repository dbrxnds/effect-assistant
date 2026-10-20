/**
 * This module provides a chat to drive an assistant like a user would, for tests and evals.
 *
 * {@link chat} wraps a chat the app created. Each step (`say`, `approve`, `reject`, `answer`, or
 * `send` for any input) submits the input, waits until a turn has handled it, and returns the chat
 * as it is then. A {@link Log} reads what the assistant did, for the whole chat or for the last
 * step alone (`step`): the tools that ran, the blocks it showed, the calls waiting for approval,
 * and the messages it sent.
 *
 * **Example** (An assistant asks before it emails)
 *
 * ```ts
 * import { AssistantTest } from "effect-assistant"
 * import * as Effect from "effect/Effect"
 *
 * const program = Effect.gen(function* () {
 *   const chat = AssistantTest.chat(yield* MyAssistant, chatId)
 *   const asked = yield* chat.say("Email the report to ana@example.com")
 *   asked.step.waitingFor // ["send_report"]
 *   const sent = yield* asked.approve
 *   sent.step.toolsRun // ["send_report"]
 * })
 * ```
 *
 * @since 0.9.0
 */
import * as Data from "effect/Data"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as Assistant from "./Assistant.ts"
import type * as Block from "./Block.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import type { ChatId } from "./ChatId.ts"
import * as InputId from "./InputId.ts"
import { sendUserMessageName, waitToolName } from "./internal/tools.ts"
import * as ToolApproval from "./ToolApproval.ts"

// The assistant's own tools: how it talks, waits and reads its skills, not work it does for the user.
const ownTools: ReadonlySet<string> = new Set([sendUserMessageName, waitToolName, "load_skill"])

/**
 * Represents a step that couldn't complete: no turn handled the input in time, the turn failed,
 * or there was nothing to approve or answer.
 *
 * @category errors
 * @since 0.9.0
 */
export class TestChatError extends Data.TaggedError("TestChatError")<{
  readonly reason: "TimedOut" | "TurnFailed" | "NothingToApprove" | "NothingToAnswer"
  readonly message: string
}> {}

const libraryEvents = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): ReadonlyArray<AssistantEvent.AssistantEvent> =>
  entries.flatMap(({ event }) => (AssistantEvent.isLibraryEvent(event) ? [event] : []))

/**
 * Represents what the assistant did in some of a chat's entries.
 *
 * @category models
 * @since 0.9.0
 */
export interface Log {
  readonly entries: ReadonlyArray<AssistantEvent.AnyEntry>
  /**
   * The app's tools that ran, each once, in the order they first ran. A call that failed or that
   * the library refused didn't run, and the assistant's own tools (`send_user_message`, `wait`,
   * `load_skill`) aren't listed.
   */
  readonly toolsRun: ReadonlyArray<string>
  /** How many times the model called this tool, whether or not it ran. */
  readonly toolCalls: (tool: string) => number
  /** The kind of each block the assistant showed, in order; one per message. */
  readonly blocks: ReadonlyArray<string>
  /** The calls waiting for the user's approval, in order. */
  readonly approvals: ReadonlyArray<AssistantEvent.ApprovalRequested>
  /** The tools of the calls waiting for the user's approval. */
  readonly waitingFor: ReadonlyArray<string>
  /** The messages the assistant sent, in order. */
  readonly messages: ReadonlyArray<string>
}

/**
 * Reads what the assistant did in these entries.
 *
 * @category constructors
 * @since 0.9.0
 */
export const log = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): Log => {
  const events = libraryEvents(entries)
  const results = events.flatMap((event) => (Predicate.isTagged(event, "ToolResult") ? [event] : []))
  const approvals = events.flatMap((event) => (Predicate.isTagged(event, "ApprovalRequested") ? [event] : []))

  return {
    entries,
    toolsRun: [
      ...new Set(
        results.filter(({ outcome, tool }) => outcome === "success" && !ownTools.has(tool)).map(({ tool }) => tool)
      )
    ],
    toolCalls: (tool) => results.filter((result) => result.tool === tool).length,
    blocks: events.flatMap((event) =>
      Predicate.isTagged(event, "AssistantMessage") && event.block !== undefined ? [event.block.kind] : []
    ),
    approvals,
    waitingFor: approvals.map(({ tool }) => tool),
    messages: AssistantEvent.assistantTexts(entries)
  }
}

/**
 * Represents a chat driven like a user would.
 *
 * @category models
 * @since 0.9.0
 */
export interface TestChat extends Log {
  readonly chatId: ChatId
  /** What the assistant did for the last step alone. */
  readonly step: Log
  /** Submits an input, and returns the chat once a turn has handled it. */
  readonly send: (input: AssistantEvent.Input) => Effect.Effect<TestChat, TestChatError>
  /** Sends the user's message. */
  readonly say: (text: string) => Effect.Effect<TestChat, TestChatError>
  /** Approves the last call waiting for approval. */
  readonly approve: Effect.Effect<TestChat, TestChatError>
  /** Rejects the last call waiting for approval. */
  readonly reject: (options?: { readonly reason?: string | undefined }) => Effect.Effect<TestChat, TestChatError>
  /** Answers the last block of this kind the assistant showed. */
  readonly answer: <Answer extends Block.Codec>(
    block: Block.Block<string, Block.Codec, Answer>,
    answer: Answer["Type"]
  ) => Effect.Effect<TestChat, TestChatError>
}

const handled = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, inputId: string): boolean => {
  const input = entries.find(({ event }) => AssistantEvent.isInput(event) && event.id === inputId)

  return (
    input !== undefined &&
    libraryEvents(entries).some((event) => AssistantEvent.isTurnEnd(event) && event.throughSequence >= input.sequence)
  )
}

/**
 * Creates a chat to drive the assistant with, for a chat the app already created. A step fails
 * when no turn has handled its input within `timeout` (3 minutes by default), or when a turn failed
 * while handling it.
 *
 * @category constructors
 * @since 0.9.0
 */
export const chat = <Events extends { readonly _tag: string } = never>(
  assistant: Assistant.Service<Events>,
  chatId: ChatId,
  options?: { readonly timeout?: Duration.Input | undefined }
): TestChat => at(assistant, chatId, options?.timeout ?? "3 minutes", [], [])

const at = <Events extends { readonly _tag: string }>(
  assistant: Assistant.Service<Events>,
  chatId: ChatId,
  timeout: Duration.Input,
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  step: ReadonlyArray<AssistantEvent.AnyEntry>
): TestChat => {
  const all = log(entries)

  const send = (input: AssistantEvent.Input): Effect.Effect<TestChat, TestChatError> =>
    Effect.gen(function* () {
      const before = entries.at(-1)?.sequence ?? 0
      let seen: ReadonlyArray<AssistantEvent.AnyEntry> = []

      yield* assistant.submit(chatId, input).pipe(Effect.orDie)

      const after = yield* assistant.subscribe(chatId).pipe(
        Stream.scan(
          (): ReadonlyArray<AssistantEvent.AnyEntry> => [],
          (acc, entry) => [...acc, entry]
        ),
        Stream.tap((acc) => Effect.sync(() => (seen = acc))),
        Stream.takeUntil((acc) => handled(acc, input.id)),
        Stream.runLast,
        Effect.map(Option.getOrElse((): ReadonlyArray<AssistantEvent.AnyEntry> => [])),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(
              new TestChatError({
                reason: "TimedOut",
                message: `no turn handled the input; the assistant said: ${log(seen).messages.join(" | ")}`
              })
            )
        })
      )

      const added = after.filter(({ sequence }) => sequence > before)

      const failed = libraryEvents(added).flatMap((event) =>
        Predicate.isTagged(event, "TurnFailed") ? [event.message] : []
      )

      if (failed.length > 0) {
        return yield* new TestChatError({ reason: "TurnFailed", message: failed.join(" | ") })
      }

      return at(assistant, chatId, timeout, after, added)
    })

  const decide = (decision: (approval: { readonly id: string }) => AssistantEvent.ApprovalDecision) => {
    const waiting = all.approvals.at(-1)

    return waiting === undefined
      ? Effect.fail(new TestChatError({ reason: "NothingToApprove", message: "no call waits for approval" }))
      : send(decision({ id: waiting.callId }))
  }

  const answer = <Answer extends Block.Codec>(
    block: Block.Block<string, Block.Codec, Answer>,
    value: Answer["Type"]
  ): Effect.Effect<TestChat, TestChatError> => {
    const asked = libraryEvents(entries).findLast(
      (event): event is AssistantEvent.AssistantMessage =>
        Predicate.isTagged(event, "AssistantMessage") && event.block?.kind === block.kind
    )

    if (asked === undefined || block.answer === undefined) {
      return Effect.fail(new TestChatError({ reason: "NothingToAnswer", message: `no ${block.kind} block to answer` }))
    }

    return send(
      AssistantEvent.BlockAnswer.make({
        // As the client sends it: the same id every time, so a block takes one answer.
        id: InputId.fromKey(`${asked.id}:answer`),
        messageId: asked.id,
        kind: block.kind,
        value: Schema.encodeUnknownSync(Schema.toCodecJson(block.answer))(value)
      })
    )
  }

  return {
    ...all,
    chatId,
    step: log(step),
    send,
    say: (text) => send(AssistantEvent.UserMessage.make({ text })),
    approve: decide(ToolApproval.approve),
    reject: (options) => decide((approval) => ToolApproval.reject(approval, options)),
    answer
  }
}
