/**
 * The `Compaction` module holds what a long chat needs so the model can read
 * a summary instead of everything before it. When to compact, which model
 * writes the summary, and what the summary says are the app's: its handler
 * reads the chat's entries, has a model write the summary, stores it as one
 * of its own events, and its loop reads the chat with {@link since}.
 */
import type * as Prompt from "effect/ai/Prompt"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type * as Assistant from "./Assistant.ts"
import * as AssistantActivity from "./AssistantActivity.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import * as BlockKit from "./BlockKit.ts"
import * as Decision from "./Decision.ts"
import { userText } from "./internal/history.ts"
import { toJsonText } from "./internal/schema.ts"

/**
 * What a summary event has: its text, and the last `seq` it covers. Entries
 * after `throughSeq` stay as they are, so an input that arrived while the
 * summary was written isn't lost.
 */
export interface Summary {
  readonly _tag: string
  readonly text: string
  readonly throughSeq: number
}

/**
 * Returns the input tokens of the chat's last model call: how big the prompt
 * has grown. 0 before the first call.
 */
export const inputTokens = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): number => {
  const last = entries.findLast(
    ({ event }) =>
      AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "ModelOutput") && event.usage !== undefined
  )?.event

  return last !== undefined && AssistantEvent.isLibraryEvent(last) && Predicate.isTagged(last, "ModelOutput")
    ? (last.usage?.inputTokens.total ?? 0)
    : 0
}

/**
 * Returns what was still open at `throughSeq` and still is: decisions waiting
 * for the user, blocks the user hasn't answered, and specialists working. As
 * text for the model, or none when nothing is.
 */
export const openItems = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  throughSeq: number
): Option.Option<string> => {
  const seqOf = (found: (event: AssistantEvent.AnyEntry["event"]) => boolean) =>
    entries.find(({ event }) => found(event))?.seq ?? Number.POSITIVE_INFINITY

  const opened = (seq: number) => seq <= throughSeq

  const decisions = [...Decision.fromEntries(entries).values()].flatMap((state) =>
    state.outcome === undefined &&
    opened(
      seqOf(
        (event) =>
          AssistantEvent.isLibraryEvent(event) &&
          Predicate.isTagged(event, "DecisionRequested") &&
          event.id === state.request.id
      )
    )
      ? [`- decision ${state.request.id}, for ${state.request.origin.tool}: ${toJsonText(state.request.origin.params)}`]
      : []
  )

  const blocks = [...BlockKit.blockStates(entries)].flatMap(([messageId, state]) => {
    const shown = entries.find(
      ({ event }) =>
        AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "AssistantMessage") && event.id === messageId
    )

    const message = shown?.event

    return state.open &&
      shown !== undefined &&
      opened(shown.seq) &&
      message !== undefined &&
      AssistantEvent.isLibraryEvent(message) &&
      Predicate.isTagged(message, "AssistantMessage")
      ? [`- message ${messageId}, a ${message.block?.kind} block: ${message.text}`]
      : []
  })

  const specialists = [...AssistantActivity.fromEntries(entries).specialists.values()].flatMap((run) =>
    opened(
      seqOf(
        (event) =>
          AssistantEvent.isLibraryEvent(event) &&
          Predicate.isTagged(event, "SpecialistStarted") &&
          event.runId === run.runId
      )
    )
      ? [`- your ${run.specialist} specialist (${run.runId}), working on: ${run.goal}`]
      : []
  )

  const sections = [
    decisions.length > 0 ? `Decisions waiting for the user:\n${decisions.join("\n")}` : "",
    blocks.length > 0 ? `Blocks the user hasn't answered:\n${blocks.join("\n")}` : "",
    specialists.length > 0 ? `Specialists still working:\n${specialists.join("\n")}` : ""
  ].filter((section) => section.length > 0)

  return sections.length === 0 ? Option.none() : Option.some(sections.join("\n\n"))
}

/**
 * The files the user attached up to `throughSeq`, as lines for the model, or
 * none. A summary may drop a file's id, and tools need it.
 */
export const attachedFiles = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  throughSeq: number
): Option.Option<string> => {
  const lines = entries.flatMap(({ seq, event }) =>
    seq <= throughSeq && AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "UserMessage")
      ? (event.attachments ?? []).map(AssistantEvent.attachmentLine)
      : []
  )

  return lines.length === 0 ? Option.none() : Option.some(lines.join("\n"))
}

/**
 * A history view that starts at the last summary: the summary, what is still
 * open, then the entries after it. Without a summary, every entry.
 */
export const since =
  (isSummary: (event: unknown) => event is Summary) =>
  <Events extends { readonly _tag: string }>(
    entries: ReadonlyArray<Assistant.Entry<Events>>
  ): ReadonlyArray<Assistant.Entry<Events> | Prompt.Message> => {
    const last = entries.findLast(({ event }) => isSummary(event))?.event

    if (last === undefined || !isSummary(last)) return entries

    const open = Option.match(openItems(entries, last.throughSeq), {
      onNone: () => "",
      onSome: (items) => `\n\n<still_open>\n${items}\n</still_open>`
    })

    const files = Option.match(attachedFiles(entries, last.throughSeq), {
      onNone: () => "",
      onSome: (lines) => `\n\n<files_attached_earlier>\n${lines}\n</files_attached_earlier>`
    })

    return [
      userText(`<earlier_in_this_chat>\n${last.text}\n</earlier_in_this_chat>${files}${open}`),
      ...entries.filter(({ seq, event }) => seq > last.throughSeq && !isSummary(event))
    ]
  }
