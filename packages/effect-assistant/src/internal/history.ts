import * as Prompt from "effect/ai/Prompt"
import * as Response from "effect/ai/Response"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as AssistantEvent from "../AssistantEvent.ts"
import { toJson, toJsonText } from "./schema.ts"
import * as Uuid from "./uuid.ts"

/** @internal */
export const userText = (text: string): Prompt.UserMessage =>
  Prompt.userMessage({ content: [Prompt.textPart({ text })] })

/** @internal */
export const toolMessage = (result: AssistantEvent.ToolResult): Prompt.ToolMessage =>
  Prompt.toolMessage({
    content: [
      Prompt.toolResultPart({
        id: result.callId,
        name: result.tool,
        isFailure: result.outcome === "failure",
        result: result.result,
        providerExecuted: false
      })
    ]
  })

// A call with no result is one a crash cut off.
/** @internal */
export const unansweredCalls = (history: ReadonlyArray<Prompt.Message>): ReadonlyArray<AssistantEvent.ToolCallPart> => {
  const answered = new Set(
    history.flatMap((message) =>
      message.role === "tool" ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.id] : [])) : []
    )
  )

  return history.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) =>
          part.type === "tool-call" && !part.providerExecuted && !answered.has(part.id)
            ? [
                Response.makePart("tool-call", {
                  id: part.id,
                  name: part.name,
                  params: toJson(part.params),
                  providerExecuted: false,
                  metadata: part.options
                })
              ]
            : []
        )
      : []
  )
}

/** @internal */
export const notRunOutput = "Not run: the turn ended before this call ran."

/** @internal */
export const mayHaveRunOutput =
  "Stopped: the turn ended while this call ran. It may have done its work; check before doing it again."

const ago = (millis: number) => {
  const seconds = Math.max(0, Math.round(millis / 1000))

  return seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`
}

const finishedText = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  index: number,
  finished: AssistantEvent.SpecialistFinished
) => {
  const at = entries[index]!

  const isStart = ({ event }: AssistantEvent.AnyEntry) =>
    AssistantEvent.isLibraryEvent(event) &&
    Predicate.isTagged(event, "SpecialistStarted") &&
    event.runId === finished.runId

  const from = entries.slice(0, index).findLastIndex(isStart)
  const started = from === -1 ? undefined : entries[from]
  const since = started === undefined ? [] : entries.slice(from + 1, index)
  const wrote = since.some(({ event }) => Predicate.isTagged(event, "UserMessage"))

  const lines = [
    "A report from a specialist you started. The user hasn't seen it.",
    started === undefined
      ? `You started it for: ${finished.goal}`
      : `You started it ${ago(at.at - started.at)} ago for: ${finished.goal}`,
    wrote ? "The user has written since you started it." : "The user hasn't written since you started it.",
    Match.value(finished.status).pipe(
      Match.when("answered", () => `Report:\n${finished.report ?? ""}`),
      Match.when("failed", () => `It failed: ${finished.error ?? ""}`),
      Match.when("cut_off", () => "A restart cut it off before it finished. Spawn it again if it's still needed."),
      Match.when("stopped", () => "You stopped it."),
      Match.exhaustive
    )
  ]

  return `<specialist name="${finished.specialist}" run="${finished.runId}" status="${finished.status}">\n${lines.join(
    "\n"
  )}\n</specialist>`
}

const answerText = (answer: AssistantEvent.BlockAnswer) =>
  `<answer message="${answer.messageId}" kind="${answer.kind}">\nThe user answered with the block on your message ${answer.messageId}.\n${toJsonText(answer.value)}\n</answer>`

const resultText = (result: AssistantEvent.ToolResult) =>
  `<result tool="${result.tool}" call="${result.callId}" outcome="${result.outcome}">\nThe result of a call from earlier in this chat.\n${toJsonText(result.result)}\n</result>`

/** @internal */
export const awaitingApprovalOutput =
  "Waiting for the user's approval: they see this call and approve or reject it. Its outcome arrives later in this chat; don't call it again meanwhile."

const awaitingText = (request: AssistantEvent.ApprovalRequested) =>
  `<approval tool="${request.tool}" call="${request.callId}" status="pending">\nYour call to ${request.tool} from earlier in this chat waits for the user's approval.\n${toJsonText(request.params)}\n</approval>`

const approvedText = (result: AssistantEvent.ToolResult) =>
  `<result tool="${result.tool}" call="${result.callId}" outcome="${result.outcome}">\nThe user approved your call to ${result.tool} from earlier in this chat, and it ran.\n${toJsonText(result.result)}\n</result>`

const rejectedText = (decision: AssistantEvent.ApprovalDecision, tool: string) =>
  `<approval tool="${tool}" call="${decision.callId}" decision="rejected">\nThe user rejected your call to ${tool}; it didn't run.${decision.reason === undefined ? "" : `\nTheir reason: ${decision.reason}`}\n</approval>`

const expiredText = (callId: string, tool: string) =>
  `<approval tool="${tool}" call="${callId}" status="expired">\nThe user moved on without approving your call to ${tool}; it didn't run.\n</approval>`

const awaitingMessage = (request: AssistantEvent.ApprovalRequested): Prompt.ToolMessage =>
  Prompt.toolMessage({
    content: [
      Prompt.toolResultPart({
        id: request.callId,
        name: request.tool,
        isFailure: false,
        result: awaitingApprovalOutput,
        providerExecuted: false
      })
    ]
  })

const isEntry = (item: AssistantEvent.AnyEntry | Prompt.Message): item is AssistantEvent.AnyEntry =>
  Predicate.hasProperty(item, "sequence")

// In the order the model saw the entries, not the order they were stored. A message a history view put in stands
// where it is, right after the entry before it, and waits like an input for a call's result or for the model's next
// read; the app's own events reach the model only as such messages.
/** @internal */
export const fromEntries = (
  items: ReadonlyArray<AssistantEvent.AnyEntry | Prompt.Message>
): ReadonlyArray<Prompt.Message> => {
  const entries = items.filter(isEntry)
  const history: Array<Prompt.Message> = []
  const held: Array<Prompt.Message> = []
  const open = new Set<string>()
  const called = new Set<string>()
  // Calls that waited for approval: the placeholder answered them, so what came of them later is an input.
  const requests = new Map<string, AssistantEvent.ApprovalRequested>()
  const toolOf = (callId: string) => requests.get(callId)?.tool ?? "a tool"

  const flushIfClosed = () => {
    if (open.size === 0) history.push(...held.splice(0))
  }

  const nextSeen = (from: number) => {
    const next = entries.slice(from + 1).find(({ event }) => Predicate.isTagged(event, "ModelOutput"))?.event

    return next !== undefined && AssistantEvent.isLibraryEvent(next) && Predicate.isTagged(next, "ModelOutput")
      ? next.seenThroughSequence
      : undefined
  }

  // `index` is the last entry at or before the item, and `sequence` where the item stands.
  const input = (index: number, sequence: number, item: Prompt.Message) => {
    const seen = nextSeen(index)

    if (open.size > 0 || (seen !== undefined && seen < sequence)) held.push(item)
    else history.push(item)
  }

  let index = -1

  for (const item of items) {
    if (!isEntry(item)) {
      input(index, (entries[index]?.sequence ?? 0) + 0.5, item)

      continue
    }

    index += 1

    const { event, sequence } = item
    const at = index

    if (!AssistantEvent.isLibraryEvent(event)) continue

    Match.value(event).pipe(
      Match.tagsExhaustive({
        UserMessage: (message) =>
          input(at, sequence, userText(AssistantEvent.textWithAttachments(message.text, message.attachments))),
        BlockAnswer: (answer) => input(at, sequence, userText(answerText(answer))),
        ModelOutput: (output) => {
          history.push(...Prompt.fromResponseParts(output.parts).content)

          for (const part of output.parts) {
            if (part.type === "tool-call") {
              open.add(part.id)
              called.add(part.id)
            }
          }

          flushIfClosed()
        },
        ToolResult: (result) => {
          if (requests.has(result.callId)) return input(at, sequence, userText(approvedText(result)))

          // A view that starts after the call (since a summary, say) keeps its result as text: a tool result needs its
          // call right before it.
          if (!called.has(result.callId)) return input(at, sequence, userText(resultText(result)))

          history.push(toolMessage(result))
          open.delete(result.callId)
          flushIfClosed()
        },
        AssistantMessage: () => undefined,
        ToolStarted: () => undefined,
        TurnStarted: () => undefined,
        TurnCompleted: () => undefined,
        TurnFailed: () => undefined,
        SpecialistFinished: (finished) => input(at, sequence, userText(finishedText(entries, at, finished))),
        // Every run starts in a call of the model's own (a spawn or a follow-up), whose result says so.
        SpecialistStarted: () => undefined,
        BlocksClosed: () => undefined,
        // The call's result, for the provider's pairing; what the user decides comes later.
        ApprovalRequested: (request) => {
          requests.set(request.callId, request)

          if (!called.has(request.callId)) return input(at, sequence, userText(awaitingText(request)))

          history.push(awaitingMessage(request))
          open.delete(request.callId)
          flushIfClosed()
        },
        // An approved call's result says so.
        ApprovalDecision: (decision) =>
          decision.decision === "rejected"
            ? input(at, sequence, userText(rejectedText(decision, toolOf(decision.callId))))
            : undefined,
        ApprovalsExpired: (expired) =>
          expired.callIds.forEach((callId) => input(at, sequence, userText(expiredText(callId, toolOf(callId))))),
        ChatDeleted: () => undefined
      })
    )
  }

  return [...history, ...held]
}

/** @internal */
export const isInput = (event: { readonly _tag: string }): boolean =>
  AssistantEvent.isInput(event) || AssistantEvent.isAppInput(event)

/** @internal */
export const handledThrough = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): number => {
  const last = entries.findLast(({ event }) => AssistantEvent.isTurnEnd(event))?.event

  return last !== undefined && AssistantEvent.isTurnEnd(last) ? last.throughSequence : 0
}

// A run the assistant stopped isn't an input here: it wakes nothing.
/** @internal */
export const unhandledInputs = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>
): ReadonlyArray<{ readonly _tag: string }> => {
  const seen = handledThrough(entries)

  return entries.flatMap(({ event, sequence }) =>
    sequence > seen && isInput(event) && !(AssistantEvent.isInput(event) && !AssistantEvent.isWaking(event))
      ? [event]
      : []
  )
}

/** @internal */
export const needsTurn = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): boolean =>
  unhandledInputs(entries).length > 0

// A failure the user was shown counts as a reply, and so does a call they're asked to approve.
/** @internal */
export const owesReply = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, throughSequence: number): boolean => {
  const latest = entries.findLast(
    ({ event, sequence }) =>
      sequence <= throughSequence && AssistantEvent.isInput(event) && AssistantEvent.isUserInput(event)
  )

  return (
    latest !== undefined &&
    !entries.some(
      ({ event, sequence }) =>
        sequence > latest.sequence &&
        (Predicate.isTagged(event, "AssistantMessage") ||
          Predicate.isTagged(event, "TurnFailed") ||
          Predicate.isTagged(event, "ApprovalRequested"))
    )
  )
}

const sentToWaitOn = Schema.decodeUnknownOption(Schema.Struct({ wait: Schema.Literal(false) }))

// Messages sent with `wait: false` are progress while the model kept working, like "On it".
const progressMessages = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): ReadonlySet<string> =>
  new Set(
    entries.flatMap(({ event }) =>
      AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "ModelOutput")
        ? event.parts.flatMap((part) =>
            part.type === "tool-call" && part.name === "send_user_message" && Option.isSome(sentToWaitOn(part.params))
              ? [Uuid.fromKey(`message:${part.id}`)]
              : []
          )
        : []
    )
  )

// The model said it was on it and stopped without the result: only progress messages since the user's latest input.
// A specialist still working doesn't count, since its report is what comes next.
/** @internal */
export const owesDelivery = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, throughSequence: number): boolean => {
  const latest = entries.findLast(
    ({ event, sequence }) =>
      sequence <= throughSequence && AssistantEvent.isInput(event) && AssistantEvent.isUserInput(event)
  )

  if (latest === undefined) return false

  const after = entries.flatMap(({ sequence, event }) =>
    sequence > latest.sequence && AssistantEvent.isLibraryEvent(event) ? [event] : []
  )

  const messages = after.flatMap((event) => (Predicate.isTagged(event, "AssistantMessage") ? [event] : []))
  const progress = progressMessages(entries)
  const started = after.flatMap((event) => (Predicate.isTagged(event, "SpecialistStarted") ? [event.runId] : []))

  const finished = new Set(
    entries.flatMap(({ event }) =>
      AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "SpecialistFinished") ? [event.runId] : []
    )
  )

  // A call waiting for the user's approval is what comes next, like a specialist's report.
  return (
    messages.length > 0 &&
    messages.every((message) => message.block === undefined && progress.has(message.id)) &&
    !after.some((event) => Predicate.isTagged(event, "TurnFailed") || Predicate.isTagged(event, "ApprovalRequested")) &&
    started.every((runId) => finished.has(runId))
  )
}

/** @internal */
export const unreadAfter = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, throughSequence: number): boolean =>
  entries.some(({ event, sequence }) => sequence > throughSequence && isInput(event))
