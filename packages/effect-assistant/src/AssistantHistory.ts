/**
 * The `AssistantHistory` module turns a chat's entries into the model's
 * history: the same rules `turn.history` uses, for any slice of the log.
 *
 * **Example** (A history that starts at the last summary)
 *
 * ```ts
 * import * as Items from "@effect-uai/core/Items"
 * import { AssistantHistory } from "effect-assistant"
 *
 * const history = turn.entries.pipe(
 *   Effect.map((entries) => {
 *     const summary = entries.findLast((entry) => Predicate.isTagged(entry.event, "Summary"))
 *     const since = entries.filter((entry) => entry.seq > (summary?.event.throughSeq ?? 0))
 *
 *     return AssistantHistory.fromEntries(since, {
 *       before: summary === undefined ? [] : [Items.userText(`Earlier in this chat: ${summary.event.text}`)]
 *     })
 *   })
 * )
 * ```
 *
 * @since 0.1.0
 */
import type * as Items from "@effect-uai/core/Items"
import * as Schema from "effect/Schema"
import type * as Assistant from "./Assistant.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import * as History from "./internal/history.ts"

const isAssistantEvent = Schema.is(AssistantEvent.AssistantEvent)

/**
 * Returns the model's history for these entries, in the order the model saw
 * them. The app's own events are left out; `before` goes first, like a
 * summary of what came before the slice.
 *
 * **Details**
 *
 * Inputs that arrived while tool calls were open wait until the calls have
 * results, and inputs that arrived while the model wrote a step come after
 * it. Calls without a result stay open: the agent loop runs them again.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromEntries = (
  entries: ReadonlyArray<Assistant.Entry<unknown>>,
  options?: { readonly before?: ReadonlyArray<Items.HistoryItem> | undefined }
): ReadonlyArray<Items.HistoryItem> => {
  const own = entries.flatMap((entry) =>
    isAssistantEvent(entry.event)
      ? [AssistantEvent.Entry.make({ chatId: entry.chatId, seq: entry.seq, at: entry.at, event: entry.event })]
      : []
  )

  return [...(options?.before ?? []), ...History.fromEntries(own)]
}
