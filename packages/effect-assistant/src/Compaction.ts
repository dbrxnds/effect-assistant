/**
 * The `Compaction` module holds what a long chat needs so the model can read
 * a summary instead of everything before it. When to compact, which model
 * writes the summary, and what the summary says are the app's: its handler
 * asks the model for a summary with `AssistantLoop.summarize` over the
 * loop's own request (`turn.request`), stores it as one of its own events,
 * and its loop reads the chat with {@link since}.
 *
 * The chat's log keeps everything; only what the model reads gets shorter.
 * What is still open (decisions waiting for the user, blocks not answered
 * yet, specialists still working) is read from the log, not from the
 * summary, so it survives any summary.
 *
 * **Example** (Compacting once the prompt passes 100k tokens)
 *
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import * as Stream from "effect/Stream"
 * import { AppEvent, Assistant, AssistantLoop, Compaction } from "effect-assistant"
 *
 * class Summary extends Schema.TaggedClass<Summary>()("Summary", {
 *   text: Schema.String,
 *   throughSeq: Schema.Int
 * }) {}
 *
 * const MyAssistant = Assistant.make("my-assistant", { events: [AppEvent.make(Summary)] })
 * const history = Compaction.since(Schema.is(Summary))
 *
 * const MyAssistantLive = MyAssistant.toLayer((turn) => {
 *   const options = { instructions: "You help a small team.", history }
 *
 *   const compact = Effect.gen(function*() {
 *     const entries = yield* turn.entries
 *     if (Compaction.inputTokens(entries) < 100_000) return
 *
 *     const text = yield* AssistantLoop.summarize({
 *       ...turn.request(options),
 *       prompt: "Summarize this chat so far: …"
 *     })
 *     yield* turn.append(Summary.make({ text, throughSeq: entries.at(-1)?.seq ?? 0 }))
 *   })
 *
 *   return Stream.concat(turn.loop(options), Stream.drain(Stream.fromEffect(compact)))
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type * as Prompt from "effect/unstable/ai/Prompt"
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
 *
 * @category models
 * @since 0.1.0
 */
export interface Summary {
  readonly _tag: string
  readonly text: string
  readonly throughSeq: number
}

/**
 * Returns the input tokens of the chat's last model call: how big the prompt
 * has grown. 0 before the first call.
 *
 * @category folding
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

/** What asks for a decision: the tool its call is for, or the work that asks. */
const originOf = (request: AssistantEvent.DecisionRequested): string =>
  Predicate.isTagged(request.origin, "Call") ? request.origin.tool : request.origin.source

/**
 * Returns what was still open at `throughSeq` and still is: decisions waiting
 * for the user, blocks the user hasn't answered, and specialists working. As
 * text for the model, or none when nothing is.
 *
 * @category folding
 * @since 0.1.0
 */
export const openItems = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  throughSeq: number
): Option.Option<string> => {
  const seqOf = (found: (event: AssistantEvent.AnyEntry["event"]) => boolean) =>
    entries.find(({ event }) => found(event))?.seq ?? Number.POSITIVE_INFINITY

  const opened = (seq: number) => seq <= throughSeq

  const decisions = [...Decision.states(entries).values()].flatMap((state) =>
    state.outcome === undefined &&
    opened(
      seqOf(
        (event) =>
          AssistantEvent.isLibraryEvent(event) &&
          Predicate.isTagged(event, "DecisionRequested") &&
          event.id === state.request.id
      )
    )
      ? [`- decision ${state.request.id}, for ${originOf(state.request)}: ${toJsonText(state.request.preview)}`]
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
 * A history view that starts at the last summary: the summary, what is still
 * open, then the entries after it. Without a summary, every entry.
 *
 * @category constructors
 * @since 0.1.0
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

    return [
      userText(`<earlier_in_this_chat>\n${last.text}\n</earlier_in_this_chat>${open}`),
      ...entries.filter(({ seq, event }) => seq > last.throughSeq && !isSummary(event))
    ]
  }
