import type * as Prompt from "effect/ai/Prompt"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import type * as AssistantEvent from "../AssistantEvent.ts"
import type * as StatusSummary from "../StatusSummary.ts"
import * as History from "./history.ts"
import * as Live from "./live.ts"
import { toJsonText } from "./schema.ts"
import type { Writer } from "./writer.ts"

const MAX_LINE = 300

const MAX_MESSAGES = 12

const clip = (text: string) => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text)

const assistantLines = (part: Prompt.AssistantMessagePart): ReadonlyArray<string> => {
  switch (part.type) {
    case "text":
      return [`Assistant: ${clip(part.text)}`]
    case "tool-call":
      return [`Assistant runs ${part.name} ${clip(toJsonText(part.params))}`]
    default:
      return []
  }
}

const lines = (message: Prompt.Message): ReadonlyArray<string> => {
  switch (message.role) {
    case "system":
      return []
    case "user":
      return message.content.flatMap((part) => (part.type === "text" ? [`User: ${clip(part.text)}`] : []))
    case "assistant":
      return message.content.flatMap(assistantLines)
    case "tool":
      return message.content.flatMap((part) =>
        part.type === "tool-result"
          ? [`Result of ${part.name}: ${clip(Predicate.isString(part.result) ? part.result : toJsonText(part.result))}`]
          : []
      )
  }
}

// The latest messages, as plain lines: the summary's model gets no tools, so no tool call parts.
/** @internal */
export const transcript = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): string =>
  History.fromEntries(entries).slice(-MAX_MESSAGES).flatMap(lines).join("\n")

const isBusy = (state: Live.State) =>
  state.typing || [...state.statuses.values()].some((status) => status.source === "tool")

const lastSequence = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => entries.at(-1)?.sequence ?? 0

const isWork = (event: { readonly _tag: string }) =>
  Predicate.isTagged(event, "TurnStarted") ||
  Predicate.isTagged(event, "ModelOutput") ||
  Predicate.isTagged(event, "ToolStarted")

// After a message the user is up to date: a summary shows again only for work the model started since, not for what a
// handler does after its reply (a compaction, say).
const workingSinceMessage = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => {
  const message = entries.findLastIndex(({ event }) => Predicate.isTagged(event, "AssistantMessage"))

  return message === -1 || entries.slice(message + 1).some(({ event }) => isWork(event))
}

// While the turn runs with no tool status and no message on its way, a summary of what it did, written again only
// after something new happened.
/** @internal */
export const run = Effect.fnUntraced(function* (
  summary: StatusSummary.StatusSummary["Service"],
  live: Live.Live,
  chat: Writer
) {
  const summarized = yield* Ref.make(-1)

  const tick = Effect.gen(function* () {
    const entries = yield* chat.entries
    const through = lastSequence(entries)

    if (isBusy(yield* live.state) || through === (yield* Ref.get(summarized)) || !workingSinceMessage(entries)) return

    const written = yield* summary.summarize(transcript(entries))

    yield* Ref.set(summarized, through)

    // The model may have started a message, or a tool its own status, while the summary was written.
    if (Option.isSome(written) && !isBusy(yield* live.state)) {
      yield* live.show(Live.summaryKey, written.value, "summary")
    }
  })

  yield* Effect.sleep(summary.after)
  yield* tick.pipe(Effect.repeat(Schedule.spaced(summary.every)))
})
