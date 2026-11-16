import type * as Prompt from "effect/ai/Prompt"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as AssistantEvent from "../AssistantEvent.ts"
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

// The calls started and not answered yet: what the assistant is doing right now.
const runningCalls = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => {
  const events = entries.flatMap(({ event }) => (AssistantEvent.isLibraryEvent(event) ? [event] : []))
  const answered = new Set(events.flatMap((event) => (Predicate.isTagged(event, "ToolResult") ? [event.callId] : [])))

  return events.flatMap((event) =>
    Predicate.isTagged(event, "ToolStarted") && !answered.has(event.callId) ? [event.tool] : []
  )
}

// The latest messages, as plain lines, and what still runs: the summary's model gets no tools, so no tool call parts.
/** @internal */
export const transcript = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): string => {
  const running = runningCalls(entries)
  const lastLines = History.fromEntries(entries).slice(-MAX_MESSAGES).flatMap(lines)

  return [...lastLines, ...(running.length === 0 ? [] : [`Running now: ${running.join(", ")}`])].join("\n")
}

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

const MAX_CHECK_MILLIS = 500

// A line for a turn that shows nothing for a while, or whose line hasn't changed for longer: never while a described
// call says what runs, or the model writes to the user, and only after something new happened.
/** @internal */
export const run = Effect.fnUntraced(function* (
  summary: StatusSummary.StatusSummary["Service"],
  live: Live.Live,
  chat: Writer
) {
  const summarized = yield* Ref.make(-1)
  const after = Duration.toMillis(summary.after)
  const staleAfter = Duration.toMillis(summary.staleAfter)

  const tick = Effect.gen(function* () {
    const current = yield* live.state
    const entries = yield* chat.entries
    const through = lastSequence(entries)
    const waited = (yield* Clock.currentTimeMillis) - current.shownAt

    if (
      current.typing ||
      current.running.length > 0 ||
      waited < (current.shown === undefined ? after : staleAfter) ||
      through === (yield* Ref.get(summarized)) ||
      !workingSinceMessage(entries)
    ) {
      return
    }

    const written = yield* summary.summarize(transcript(entries))

    yield* Ref.set(summarized, through)

    if (Option.isSome(written)) yield* live.summarized(written.value)
  })

  // Often enough that a line is filled or refreshed close to when it's due.
  yield* tick.pipe(Effect.repeat(Schedule.spaced(Math.min(MAX_CHECK_MILLIS, after / 2, staleAfter / 2))))
})
