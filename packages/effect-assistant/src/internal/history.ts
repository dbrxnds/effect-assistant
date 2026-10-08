import * as Prompt from "effect/ai/Prompt"
import * as Response from "effect/ai/Response"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as AssistantEvent from "../AssistantEvent.ts"
import * as Decision from "../Decision.ts"
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

/** @internal */
export const parkedResult = (
  request: AssistantEvent.DecisionRequested,
  origin: AssistantEvent.CallOrigin
): Prompt.ToolMessage =>
  Prompt.toolMessage({
    content: [
      Prompt.toolResultPart({
        id: origin.callId,
        name: origin.tool,
        isFailure: false,
        result: {
          status: "waiting_for_decision",
          decisionId: request.id,
          next: "Not run: it runs only if the user approves it. Send them a message with a decision block for this decisionId that says what they approve (the call's key facts). Their answer runs it, or declines it."
        },
        providerExecuted: false
      })
    ]
  })

const whatDecided = (request: AssistantEvent.DecisionRequested, outcome: AssistantEvent.DecisionOutcome) =>
  outcome === "approved"
    ? `approved: ${request.origin.tool} runs now, and its result follows.`
    : `declined: ${request.origin.tool} didn't run, and won't.`

const decodeDecisionAnswer = Schema.decodeUnknownOption(Decision.Answer)

const decisionAnswerText = (
  answer: AssistantEvent.BlockAnswer,
  requests: ReadonlyMap<string, AssistantEvent.DecisionRequested>
) =>
  Option.match(decodeDecisionAnswer(answer.value), {
    onNone: () => answerText(answer),
    onSome: ({ decisions }) => {
      const lines = Object.entries(decisions).map(([id, outcome]) => {
        const request = requests.get(id)

        return `- ${id}: ${request === undefined ? outcome : whatDecided(request, outcome)}`
      })

      return `<answer message="${answer.messageId}" kind="${answer.kind}">\nThe user decided with the block on your message ${answer.messageId}:\n${lines.join("\n")}\n</answer>`
    }
  })

const resultText = (result: AssistantEvent.ToolResult) =>
  `<result tool="${result.tool}" call="${result.callId}" outcome="${result.outcome}">\nThe result of a call from earlier in this chat.\n${toJsonText(result.result)}\n</result>`

const approvedResultText = (
  request: AssistantEvent.DecisionRequested,
  tool: string,
  result: AssistantEvent.ToolResult
) =>
  `<decision id="${request.id}" tool="${tool}" outcome="approved">\nThe user approved it, and ${tool} ran: ${result.outcome}.\n${toJsonText(result.result)}\n</decision>`

// In the order the model saw the entries, not the order they were stored.
/** @internal */
export const fromEntries = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  readApp: (event: { readonly _tag: string }) => string | undefined
): ReadonlyArray<Prompt.Message> => {
  const history: Array<Prompt.Message> = []
  const held: Array<Prompt.Message> = []
  const open = new Set<string>()
  const requests = new Map<string, AssistantEvent.DecisionRequested>()
  // Parked calls by call id: their result came with the parking, so a later one reads as the decision's.
  const parked = new Map<string, AssistantEvent.DecisionRequested>()
  const called = new Set<string>()

  const flushIfClosed = () => {
    if (open.size === 0) history.push(...held.splice(0))
  }

  const nextSeen = (from: number) => {
    const next = entries.slice(from + 1).find(({ event }) => Predicate.isTagged(event, "ModelOutput"))?.event

    return next !== undefined && AssistantEvent.isLibraryEvent(next) && Predicate.isTagged(next, "ModelOutput")
      ? next.seenThroughSeq
      : undefined
  }

  const input = (index: number, item: Prompt.Message) => {
    const seen = nextSeen(index)

    if (open.size > 0 || (seen !== undefined && seen < entries[index]!.seq)) held.push(item)
    else history.push(item)
  }

  entries.forEach(({ event }, index) => {
    if (!AssistantEvent.isLibraryEvent(event)) {
      const text = readApp(event)

      if (text !== undefined) input(index, userText(text))

      return
    }

    Match.value(event).pipe(
      Match.tagsExhaustive({
        UserMessage: (message) =>
          input(index, userText(AssistantEvent.textWithAttachments(message.text, message.attachments))),
        BlockAnswer: (answer) =>
          input(
            index,
            userText(answer.kind === Decision.kind ? decisionAnswerText(answer, requests) : answerText(answer))
          ),
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
          const request = parked.get(result.callId)

          if (request !== undefined) return input(index, userText(approvedResultText(request, result.tool, result)))

          // A view that starts after the call (since a summary, say) keeps its result as text: a tool result needs its
          // call right before it. An approved call's result can come long after the call was parked.
          if (!called.has(result.callId)) return input(index, userText(resultText(result)))

          history.push(toolMessage(result))
          open.delete(result.callId)
          flushIfClosed()
        },
        DecisionRequested: (request) => {
          requests.set(request.id, request)
          parked.set(request.origin.callId, request)
          history.push(parkedResult(request, request.origin))
          open.delete(request.origin.callId)
          flushIfClosed()
        },
        DecisionResolved: () => undefined,
        AssistantMessage: () => undefined,
        ToolStarted: () => undefined,
        TurnStarted: () => undefined,
        TurnCompleted: () => undefined,
        TurnFailed: () => undefined,
        SpecialistFinished: (finished) => input(index, userText(finishedText(entries, index, finished))),
        // Every run starts in a call of the model's own (a spawn or a follow-up), whose result says so.
        SpecialistStarted: () => undefined,
        BlocksClosed: () => undefined,
        ChatDeleted: () => undefined
      })
    )
  })

  return [...history, ...held]
}

/** @internal */
export const isInput = (event: { readonly _tag: string }, wakes: ReadonlySet<string>): boolean =>
  AssistantEvent.isInput(event) || (!AssistantEvent.isLibraryEvent(event) && wakes.has(event._tag))

/** @internal */
export const handledThrough = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): number => {
  const last = entries.findLast(({ event }) => AssistantEvent.isTurnEnd(event))?.event

  return last !== undefined && AssistantEvent.isTurnEnd(last) ? last.throughSeq : 0
}

// A run the assistant stopped isn't an input here: it wakes nothing.
/** @internal */
export const unhandledInputs = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  wakes: ReadonlySet<string>
): ReadonlyArray<{ readonly _tag: string }> => {
  const seen = handledThrough(entries)

  return entries.flatMap(({ event, seq }) =>
    seq > seen && isInput(event, wakes) && !(AssistantEvent.isInput(event) && !AssistantEvent.isWaking(event))
      ? [event]
      : []
  )
}

/** @internal */
export const needsTurn = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, wakes: ReadonlySet<string>): boolean =>
  unhandledInputs(entries, wakes).length > 0

// A failure the user was shown counts as a reply.
/** @internal */
export const owesReply = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, throughSeq: number): boolean => {
  const latest = entries.findLast(
    ({ event, seq }) => seq <= throughSeq && AssistantEvent.isInput(event) && AssistantEvent.isUserInput(event)
  )

  return (
    latest !== undefined &&
    !entries.some(
      ({ event, seq }) =>
        seq > latest.seq && (Predicate.isTagged(event, "AssistantMessage") || Predicate.isTagged(event, "TurnFailed"))
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
export const owesDelivery = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, throughSeq: number): boolean => {
  const latest = entries.findLast(
    ({ event, seq }) => seq <= throughSeq && AssistantEvent.isInput(event) && AssistantEvent.isUserInput(event)
  )

  if (latest === undefined) return false

  const after = entries.flatMap(({ seq, event }) =>
    seq > latest.seq && AssistantEvent.isLibraryEvent(event) ? [event] : []
  )

  const messages = after.flatMap((event) => (Predicate.isTagged(event, "AssistantMessage") ? [event] : []))
  const progress = progressMessages(entries)
  const started = after.flatMap((event) => (Predicate.isTagged(event, "SpecialistStarted") ? [event.runId] : []))

  const finished = new Set(
    entries.flatMap(({ event }) =>
      AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "SpecialistFinished") ? [event.runId] : []
    )
  )

  return (
    messages.length > 0 &&
    messages.every((message) => message.block === undefined && progress.has(message.id)) &&
    !after.some((event) => Predicate.isTagged(event, "TurnFailed")) &&
    started.every((runId) => finished.has(runId))
  )
}

/** @internal */
export const unreadAfter = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  throughSeq: number,
  wakes: ReadonlySet<string>
): boolean => entries.some(({ event, seq }) => seq > throughSeq && isInput(event, wakes))
