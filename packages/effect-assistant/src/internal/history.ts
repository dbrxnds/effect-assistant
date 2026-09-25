/**
 * Model history from a chat's log, and whether the log needs a turn.
 *
 * @since 0.1.0
 * @internal
 */
import * as Items from "@effect-uai/core/Items"
import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import * as AssistantEvent from "../AssistantEvent.ts"

const factText = (fact: AssistantEvent.Fact) =>
  `<fact source="${fact.source}">\nAn update from a tool or workflow. The user hasn't seen it: tell them if it matters to them.\n${JSON.stringify(fact.payload)}\n</fact>`

/**
 * What a tool call gets as its result when its handler's stream stopped
 * before the call ran.
 *
 * @internal
 */
export const notRunOutput = "Not run: the turn ended before this call ran."

/**
 * What a tool call gets as its result when its handler's stream stopped while
 * the call ran: it may have done its work.
 *
 * @internal
 */
export const mayHaveRunOutput =
  "Stopped: the turn ended while this call ran. It may have done its work; check before doing it again."

/** How long ago, roughly, for the model. */
const ago = (millis: number) => {
  const seconds = Math.max(0, Math.round(millis / 1000))

  return seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`
}

/**
 * A finished run as the model reads it: what it is, how it went, how long it
 * took, whether the user wrote since it started, and its report.
 */
const finishedText = (
  entries: ReadonlyArray<AssistantEvent.Entry>,
  index: number,
  finished: AssistantEvent.SpecialistFinished
) => {
  const at = entries[index]!
  let from = index

  while (from > 0) {
    from -= 1
    const { event } = entries[from]!

    if (Predicate.isTagged(event, "SpecialistStarted") && event.runId === finished.runId) break
  }

  const started = Predicate.isTagged(entries[from]?.event, "SpecialistStarted") ? entries[from] : undefined
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
  `<answer message="${answer.messageId}" kind="${answer.kind}">\nThe user answered with the block on your message ${answer.messageId}.\n${JSON.stringify(answer.value)}\n</answer>`

/**
 * Rebuilds model history from a chat's entries, in the order the model saw
 * them.
 *
 * - Inputs that arrive while tool calls are open wait until those calls have
 *   results, so every tool call is directly followed by its output.
 * - Inputs that arrive while the model is writing a step come after that step
 *   (its `seenThroughSeq` says how far it had read), so the model doesn't
 *   take its reply as an answer to a message it never saw.
 * - Tool calls still open when a new turn starts belong to a turn a crash cut
 *   off. They stay open: the agent loop runs them again, with the same ids,
 *   before its next model call.
 *
 * @internal
 */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.Entry>): ReadonlyArray<Items.HistoryItem> => {
  const history: Array<Items.HistoryItem> = []
  const held: Array<Items.HistoryItem> = []
  const open = new Set<string>()

  const flushIfClosed = () => {
    if (open.size === 0) history.push(...held.splice(0))
  }

  /** How far the next model step had read when it was written, if there is one. */
  const nextSeen = (from: number) => {
    for (let j = from + 1; j < entries.length; j++) {
      const event = entries[j]!.event

      if (Predicate.isTagged(event, "ModelOutput")) return event.seenThroughSeq
    }

    return undefined
  }

  const input = (index: number, item: Items.HistoryItem) => {
    const seen = nextSeen(index)

    if (open.size > 0 || (seen !== undefined && seen < entries[index]!.seq)) held.push(item)
    else history.push(item)
  }

  entries.forEach(({ event }, index) =>
    Match.value(event).pipe(
      Match.tagsExhaustive({
        UserMessage: (message) => input(index, Items.userText(message.text)),
        BlockAnswer: (answer) => input(index, Items.userText(answerText(answer))),
        Fact: (fact) => input(index, Items.userText(factText(fact))),
        ModelOutput: (output) => {
          history.push(...output.items)

          for (const call of output.items.filter(Items.isToolCall)) open.add(call.call_id)
          flushIfClosed()
        },
        ToolResult: (result) => {
          history.push(Items.toolCallOutput(result.callId, result.output))
          open.delete(result.callId)
          flushIfClosed()
        },
        AssistantMessage: () => undefined,
        ToolStarted: () => undefined,
        TurnStarted: () => undefined,
        TurnCompleted: () => undefined,
        TurnFailed: () => undefined,
        SpecialistFinished: (finished) => input(index, Items.userText(finishedText(entries, index, finished))),
        SpecialistStarted: () => undefined,
        BlocksClosed: () => undefined,
        Custom: () => undefined
      })
    )
  )

  return [...history, ...held]
}

/**
 * Returns the `seq` the last finished turn read through, or 0.
 *
 * @internal
 */
export const handledThrough = (entries: ReadonlyArray<AssistantEvent.Entry>): number => {
  const last = entries.findLast(({ event }) => AssistantEvent.isTurnEnd(event))?.event

  return last !== undefined && AssistantEvent.isTurnEnd(last) ? last.throughSeq : 0
}

/**
 * Returns the inputs no finished turn has read: what the next turn is about.
 *
 * @internal
 */
export const unhandledInputs = (entries: ReadonlyArray<AssistantEvent.Entry>): ReadonlyArray<AssistantEvent.Input> => {
  const seen = handledThrough(entries)

  return entries.flatMap(({ event, seq }) =>
    seq > seen && AssistantEvent.isInput(event) && AssistantEvent.wakes(event) ? [event] : []
  )
}

/**
 * Returns whether an input arrived after the last finished turn read.
 *
 * @internal
 */
export const needsTurn = (entries: ReadonlyArray<AssistantEvent.Entry>): boolean => unhandledInputs(entries).length > 0

/**
 * Returns whether the user's latest message (or block answer) read through
 * `throughSeq` has nothing after it for them: no reply, and no failure they
 * were shown.
 *
 * @internal
 */
export const owesReply = (entries: ReadonlyArray<AssistantEvent.Entry>, throughSeq: number): boolean => {
  const latest = entries.findLast(
    ({ event, seq }) => seq <= throughSeq && AssistantEvent.isInput(event) && AssistantEvent.isClientInput(event)
  )

  return (
    latest !== undefined &&
    !entries.some(
      ({ event, seq }) =>
        seq > latest.seq && (Predicate.isTagged(event, "AssistantMessage") || Predicate.isTagged(event, "TurnFailed"))
    )
  )
}

/**
 * Returns whether an input arrived after `throughSeq`: another turn will read it.
 *
 * @internal
 */
export const unreadAfter = (entries: ReadonlyArray<AssistantEvent.Entry>, throughSeq: number): boolean =>
  entries.some(({ event, seq }) => seq > throughSeq && AssistantEvent.isInput(event))
