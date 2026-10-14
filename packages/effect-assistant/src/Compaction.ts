/**
 * This module provides what a long chat needs so that the model can read a summary in place of
 * everything before it.
 *
 * The app decides when to compact, which model writes the summary, and what the summary says.
 * Its handler reads the chat's entries, has a model write a summary, and stores the summary as one
 * of the assistant's own events (see {@link Summary}). Its loop then reads the chat through
 * {@link since}. {@link inputTokens} helps decide when the prompt has grown large enough to
 * compact. The log keeps every entry, so the user still sees the whole chat.
 *
 * @since 0.1.0
 */
import type * as Prompt from "effect/ai/Prompt"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type * as Assistant from "./Assistant.ts"
import * as AssistantActivity from "./AssistantActivity.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import * as BlockKit from "./BlockKit.ts"
import { userText } from "./internal/history.ts"
import { toJsonText } from "./internal/schema.ts"
import * as ToolApproval from "./ToolApproval.ts"

/**
 * Represents the fields a summary event must have: its text and the last `sequence` it covers.
 *
 * Entries after `throughSequence` are kept as they are, so an input that arrived while the summary was
 * being written isn't lost.
 *
 * @category models
 * @since 0.1.0
 */
export interface Summary {
  readonly _tag: string
  readonly text: string
  readonly throughSequence: number
}

/**
 * Returns the number of input tokens used by the chat's last model call, which shows how large
 * the prompt has grown. Returns 0 before the first call.
 *
 * @category utils
 * @since 0.1.0
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
 * Returns the items that were open at `throughSequence` and are still open: blocks the user hasn't
 * answered, specialists that are working, and tool calls waiting for the user's approval. The result is text for
 * the model, or `None` when nothing is open.
 *
 * @category utils
 * @since 0.1.0
 */
export const openItems = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  throughSequence: number
): Option.Option<string> => {
  const sequenceOf = (found: (event: AssistantEvent.AnyEntry["event"]) => boolean) =>
    entries.find(({ event }) => found(event))?.sequence ?? Number.POSITIVE_INFINITY

  const opened = (sequence: number) => sequence <= throughSequence

  const blocks = [...BlockKit.fromEntries(entries)].flatMap(([messageId, state]) => {
    const shown = entries.find(
      ({ event }) =>
        AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "AssistantMessage") && event.id === messageId
    )

    const message = shown?.event

    return state.open &&
      shown !== undefined &&
      opened(shown.sequence) &&
      message !== undefined &&
      AssistantEvent.isLibraryEvent(message) &&
      Predicate.isTagged(message, "AssistantMessage")
      ? [`- message ${messageId}, a ${message.block?.kind} block: ${message.text}`]
      : []
  })

  const specialists = [...AssistantActivity.fromEntries(entries).specialists.values()].flatMap((run) =>
    opened(
      sequenceOf(
        (event) =>
          AssistantEvent.isLibraryEvent(event) &&
          Predicate.isTagged(event, "SpecialistStarted") &&
          event.runId === run.runId
      )
    )
      ? [`- your ${run.specialist} specialist (${run.runId}), working on: ${run.goal}`]
      : []
  )

  const approvals = [...ToolApproval.fromEntries(entries).values()].flatMap((approval) =>
    approval.status === "pending" &&
    opened(
      sequenceOf(
        (event) =>
          AssistantEvent.isLibraryEvent(event) &&
          Predicate.isTagged(event, "ApprovalRequested") &&
          event.callId === approval.request.callId
      )
    )
      ? [`- your call to ${approval.request.tool} (${approval.request.callId}): ${toJsonText(approval.request.params)}`]
      : []
  )

  const sections = [
    blocks.length > 0 ? `Blocks the user hasn't answered:\n${blocks.join("\n")}` : "",
    specialists.length > 0 ? `Specialists still working:\n${specialists.join("\n")}` : "",
    approvals.length > 0 ? `Calls waiting for the user's approval:\n${approvals.join("\n")}` : ""
  ].filter((section) => section.length > 0)

  return sections.length === 0 ? Option.none() : Option.some(sections.join("\n\n"))
}

/**
 * Returns the files the user attached up to `throughSequence`, as lines of text for the model, or
 * `None` when there are none. A summary may leave out a file's id, which tools need.
 *
 * @category utils
 * @since 0.1.0
 */
export const attachedFiles = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  throughSequence: number
): Option.Option<string> => {
  const lines = entries.flatMap(({ sequence, event }) =>
    sequence <= throughSequence && AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "UserMessage")
      ? (event.attachments ?? []).map(AssistantEvent.attachmentLine)
      : []
  )

  return lines.length === 0 ? Option.none() : Option.some(lines.join("\n"))
}

/**
 * Creates a history view that starts at the last summary.
 *
 * **Details**
 *
 * `isSummary` identifies the app's summary events. The model reads the last summary, the files
 * attached earlier ({@link attachedFiles}), and the items that are still open
 * ({@link openItems}), followed by the entries after the summary. When the chat has no summary,
 * the view returns every entry.
 *
 * The app's other events after the summary stay entries, which the model doesn't read: map those
 * it should read to messages after this view, as with any history view (see
 * `Assistant.HistoryView`). A summary the handler appends wakes no turn.
 *
 * **Example** (Compacting a long chat after each turn)
 *
 * ```ts
 * import { Assistant, type AssistantEvent, Compaction } from "effect-assistant"
 * import * as LanguageModel from "effect/ai/LanguageModel"
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import * as Stream from "effect/Stream"
 *
 * class Summary extends Schema.TaggedClass<Summary>()("Summary", {
 *   text: Schema.String,
 *   throughSequence: Schema.Int
 * }) {}
 *
 * declare const transcript: (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => string
 *
 * export const MyAssistant = Assistant.make("my-assistant", { events: [Summary] })
 *
 * const MyAssistantLive = MyAssistant.toLayer((turn) => {
 *   const compact = Effect.gen(function* () {
 *     const chat = yield* MyAssistant.Chat
 *     const entries = yield* chat.entries
 *
 *     if (Compaction.inputTokens(entries) < 100_000) return
 *
 *     const { text } = yield* LanguageModel.generateText({
 *       prompt: `Summarize this chat:\n\n${transcript(entries)}`
 *     })
 *
 *     yield* chat.append(Summary.make({ text, throughSequence: entries.at(-1)?.sequence ?? 0 }))
 *   })
 *
 *   // After the reply, so the user doesn't wait for the summary.
 *   return Stream.concat(
 *     turn.run({ instructions: "Be brief.", history: Compaction.since(Schema.is(Summary)) }),
 *     Stream.drain(Stream.fromEffect(compact))
 *   )
 * })
 * ```
 *
 * @category utils
 * @since 0.1.0
 */
export const since =
  (isSummary: (event: unknown) => event is Summary) =>
  <Events extends { readonly _tag: string }>(
    entries: ReadonlyArray<Assistant.Entry<Events>>
  ): ReadonlyArray<Assistant.Entry<Events> | Prompt.Message> => {
    const last = entries.findLast(({ event }) => isSummary(event))?.event

    if (last === undefined || !isSummary(last)) return entries

    const open = Option.match(openItems(entries, last.throughSequence), {
      onNone: () => "",
      onSome: (items) => `\n\n<still_open>\n${items}\n</still_open>`
    })

    const files = Option.match(attachedFiles(entries, last.throughSequence), {
      onNone: () => "",
      onSome: (lines) => `\n\n<files_attached_earlier>\n${lines}\n</files_attached_earlier>`
    })

    return [
      userText(`<earlier_in_this_chat>\n${last.text}\n</earlier_in_this_chat>${files}${open}`),
      ...entries.filter(({ sequence, event }) => sequence > last.throughSequence && !isSummary(event))
    ]
  }
