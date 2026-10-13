/**
 * This module provides the view of a chat as its user sees it. A chat client receives this view
 * and nothing else.
 *
 * A {@link View} holds the chat's messages with their blocks, the app's own events it was given
 * ({@link AppEvent}), the chat's {@link Activity}, and whether the last turn failed or the chat
 * was deleted. It never contains the model's output, tool calls or results, what the model read,
 * or why a turn failed. The server streams {@link Update}s by piping the assistant's `subscribe`
 * through {@link updates}, and the client folds them with {@link apply}, starting from
 * {@link empty}. On the server, {@link fromEntries} builds a whole view from a chat's log.
 *
 * **The view shows every app event it gets.** Filter the entries to the events the chat's user may
 * see before they reach {@link updates} or {@link fromEntries}: an event that is only for the
 * assistant, like a summary of the chat, would reach the client otherwise.
 *
 * @since 0.1.0
 */
import { dual } from "effect/Function"
import * as Match from "effect/Match"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as AssistantActivity from "./AssistantActivity.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import * as BlockKit from "./BlockKit.ts"
import { InputId } from "./InputId.ts"
import * as AppEvents from "./internal/events.ts"
import { toJson } from "./internal/schema.ts"

/**
 * Schema for the status of a block. A block is `"open"` while it accepts an answer, `"answered"`
 * once the user has used it, and `"closed"` when it closed without an answer because the user
 * answered in words or moved on.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BlockStatus = Schema.Literals(["open", "answered", "closed"])

/**
 * The status of a block.
 *
 * @category models
 * @since 0.1.0
 */
export type BlockStatus = typeof BlockStatus.Type

/**
 * Schema for a block on an assistant's message. It holds the block's kind, its props (JSON, as
 * the block's props schema encodes them), its status, and the user's answer (JSON, as the block's
 * answer schema encodes it).
 *
 * @category schemas
 * @since 0.1.0
 */
export const Block = Schema.Struct({
  kind: Schema.String,
  props: Schema.Json,
  status: BlockStatus,
  answer: Schema.optional(Schema.Json)
})

/**
 * Represents a block on an assistant's message.
 *
 * @category models
 * @since 0.1.0
 */
export type Block = typeof Block.Type

/**
 * Schema for a message the user sent. `at` is when it was stored, in epoch
 * milliseconds.
 *
 * @category schemas
 * @since 0.1.0
 */
export const UserMessage = Schema.TaggedStruct("UserMessage", {
  id: InputId,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(AssistantEvent.Attachment)),
  at: Schema.Finite
})

/**
 * Represents a message the user sent.
 *
 * @category models
 * @since 0.1.0
 */
export type UserMessage = typeof UserMessage.Type

/**
 * Schema for a message the assistant sent the user, including its block if it has one.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AssistantMessage = Schema.TaggedStruct("AssistantMessage", {
  id: Schema.String,
  text: Schema.String,
  at: Schema.Finite,
  block: Schema.optional(Block)
})

/**
 * Represents a message the assistant sent the user.
 *
 * @category models
 * @since 0.1.0
 */
export type AssistantMessage = typeof AssistantMessage.Type

/**
 * Schema for one of the app's own events, as the chat's user sees it: a row between the messages,
 * in the order the chat stored it.
 *
 * **Details**
 *
 * `id` is fixed per entry of the chat's log. `tag` is the event's `_tag`, and `data` the event in
 * its schema's JSON form, `_tag` included. Read it back with {@link decodeEvent}. `at` is when it
 * was stored, in epoch milliseconds.
 *
 * @category schemas
 * @since 0.3.0
 */
export const AppEvent = Schema.TaggedStruct("AppEvent", {
  id: Schema.String,
  tag: Schema.String,
  data: Schema.Json,
  at: Schema.Finite
})

/**
 * Represents one of the app's own events, as the chat's user sees it.
 *
 * @category models
 * @since 0.3.0
 */
export type AppEvent = typeof AppEvent.Type

/**
 * Returns the event in a view's {@link AppEvent} row, decoded with its schema, or `None` when the
 * row holds another event or one that doesn't decode.
 *
 * **Example** (Showing a notice for one of the app's events)
 *
 * ```ts
 * import { ChatView } from "effect-assistant"
 * import * as Option from "effect/Option"
 * import * as Predicate from "effect/Predicate"
 * import * as Schema from "effect/Schema"
 *
 * class DailyBudgetReached extends Schema.TaggedClass<DailyBudgetReached>()("DailyBudgetReached", {}) {}
 *
 * const notice = (message: ChatView.Message) =>
 *   Predicate.isTagged(message, "AppEvent")
 *     ? Option.map(ChatView.decodeEvent(DailyBudgetReached)(message), () => "You've reached today's budget.")
 *     : Option.none()
 * ```
 *
 * @category utils
 * @since 0.3.0
 */
export const decodeEvent = <S extends AssistantEvent.AppEventSchema>(
  schema: S
): ((row: AppEvent) => Option.Option<S["Type"]>) => {
  const decode = Schema.decodeUnknownOption(Schema.toCodecJson(schema))

  return (row) => decode(row.data)
}

/**
 * Schema for an item in the chat: a message sent by either the user or the assistant, or one of
 * the app's own events.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Message = Schema.Union([UserMessage, AssistantMessage, AppEvent])

/**
 * Represents an item in the chat.
 *
 * @category models
 * @since 0.1.0
 */
export type Message = typeof Message.Type

/**
 * Schema for a specialist that is working for the assistant. It holds the specialist's name and
 * when it started, in epoch milliseconds.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SpecialistWorking = Schema.Struct({
  specialist: Schema.String,
  since: Schema.Finite
})

/**
 * Represents a specialist that is working for the assistant.
 *
 * @category models
 * @since 0.1.0
 */
export type SpecialistWorking = typeof SpecialistWorking.Type

/**
 * Schema for what is working in the chat.
 *
 * `working` is true while the assistant runs a turn, or when a turn is about to start for
 * something that arrived. `specialists` lists the specialists that are working. When the chat is
 * idle, nothing is working, even if a workflow is waiting on a timer or on the user.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Activity = Schema.Struct({
  working: Schema.Boolean,
  specialists: Schema.Array(SpecialistWorking)
})

/**
 * Represents what is working in the chat.
 *
 * @category models
 * @since 0.1.0
 */
export type Activity = typeof Activity.Type

/**
 * Schema for a chat as its user sees it. It holds the chat's messages and the app's events it was
 * given, in order, what is working in it, whether the last turn failed, and whether the chat was
 * deleted. `seq` is the position in the
 * chat's log that the view is up to.
 *
 * @category schemas
 * @since 0.1.0
 */
export const View = Schema.Struct({
  seq: Schema.Int,
  messages: Schema.Array(Message),
  activity: Activity,
  /** Whether the last turn failed with no message after it. */
  failed: Schema.Boolean,
  /** Whether the chat was deleted. A deleted chat accepts nothing more, and its stream ends. */
  deleted: Schema.Boolean
})

/**
 * Represents a chat as its user sees it.
 *
 * @category models
 * @since 0.1.0
 */
export type View = typeof View.Type

/**
 * Schema for a change to a chat's view.
 *
 * An update holds each message that is new or changed (for example, a block answered or
 * closed), in full. It also holds the current activity, whether the last turn failed,
 * and whether the chat was deleted. `seq` is the position in the chat's log that the update is up
 * to.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Update = Schema.Struct({
  seq: Schema.Int,
  messages: Schema.Array(Message),
  activity: Activity,
  failed: Schema.Boolean,
  deleted: Schema.Boolean
})

/**
 * Represents a change to a chat's view.
 *
 * @category models
 * @since 0.1.0
 */
export type Update = typeof Update.Type

/**
 * The view of a chat before anything has happened in it, with no messages and nothing working.
 * Use it as the starting point when folding updates with {@link apply}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const empty: View = {
  seq: 0,
  messages: [],
  activity: { working: false, specialists: [] },
  failed: false,
  deleted: false
}

/**
 * Returns the view after applying an update.
 *
 * **Details**
 *
 * Each message in the update replaces the message with the same id, in place, and new messages
 * are added after the rest. The update's activity, `failed`, and `deleted` replace the view's.
 * Applying an update twice changes nothing, so a client that resubscribes from the start can fold
 * again and get the same view.
 *
 * @category combinators
 * @since 0.1.0
 */
export const apply = (view: View, update: Update): View => {
  const changed = new Map(update.messages.map((message) => [message.id, message]))
  const known = new Set(view.messages.map((message) => message.id))

  return {
    seq: Math.max(view.seq, update.seq),
    messages: [
      ...view.messages.map((message) => changed.get(message.id) ?? message),
      ...update.messages.filter((message) => !known.has(message.id))
    ],
    activity: update.activity,
    failed: update.failed,
    deleted: update.deleted
  }
}

/**
 * Returns whether nothing is working in the chat: no turn is running or about to start, and no
 * specialist is working.
 *
 * @category guards
 * @since 0.1.0
 */
export const isIdle = (view: View): boolean => !view.activity.working && view.activity.specialists.length === 0

/**
 * Returns a chat's view, built from the entries of its log.
 *
 * **When to use**
 *
 * Use it in server-side code, for example to return a whole chat at once. A client gets the view
 * as a stream from {@link updates} instead.
 *
 * **Details**
 *
 * Every app event among the entries becomes an {@link AppEvent} row, so pass only those the user
 * may see. The definition's schemas give a decoded event its JSON form; without one, the event is
 * taken as it is stored, as `ChatLog.read` returns it.
 *
 * **Example** (Building a chat's view from its log)
 *
 * ```ts
 * import { type ChatId, ChatLog, ChatView } from "effect-assistant"
 * import * as Effect from "effect/Effect"
 *
 * const viewOf = (chatId: ChatId.ChatId) =>
 *   ChatLog.ChatLog.use((log) => log.read(chatId)).pipe(
 *     Effect.map((entries) => ChatView.fromEntries(entries))
 *   )
 * ```
 *
 * @see {@link updates} for a stream of changes instead of a whole view
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, definition?: Definition): View => {
  const fold = folding(definition?.events ?? [])

  for (const entry of entries) fold.step(entry)

  return fold.view
}

interface Folding {
  readonly step: (entry: AssistantEvent.AnyEntry) => Update | undefined
  readonly view: View
}

const activityOf = (activity: AssistantActivity.State): Activity => ({
  working: activity.turnSince !== undefined || activity.queued,
  specialists: [...activity.specialists.values()].map((run) => ({
    specialist: run.specialist,
    since: run.since
  }))
})

const sameActivity = (a: Activity, b: Activity) =>
  a.working === b.working &&
  a.specialists.length === b.specialists.length &&
  a.specialists.every((run, i) => {
    const other = b.specialists[i]

    return other !== undefined && run.specialist === other.specialist && run.since === other.since
  })

const folding = (events: ReadonlyArray<AssistantEvent.AppEventSchema>): Folding => {
  let seq = 0
  let failed = false
  let deleted = false
  let activity = AssistantActivity.empty
  let blocks: ReadonlyMap<string, BlockKit.State> = new Map()
  // The messages in order, and the assistant's as stored: their blocks change as the chat goes on.
  const messages = new Map<string, Message>()
  const sent = new Map<string, AssistantEvent.AssistantMessage>()

  const blockOf = (message: AssistantEvent.AssistantMessage): Block | undefined => {
    if (message.block === undefined) return undefined

    const state = blocks.get(message.id)
    const status = state === undefined || state.open ? "open" : state.answer === undefined ? "closed" : "answered"
    const block: Block = { kind: message.block.kind, props: toJson(message.block.props), status }

    return state?.answer === undefined ? block : { ...block, answer: toJson(state.answer.value) }
  }

  const viewOf = (message: AssistantEvent.AssistantMessage, at: number): AssistantMessage => {
    const block = blockOf(message)

    return block === undefined
      ? AssistantMessage.make({ id: message.id, text: message.text, at })
      : AssistantMessage.make({ id: message.id, text: message.text, at, block })
  }

  const touched = (event: AssistantEvent.AssistantEvent, at: number): ReadonlyArray<string> =>
    Match.value(event).pipe(
      Match.tagsExhaustive({
        UserMessage: (message) => {
          messages.set(
            message.id,
            message.attachments === undefined
              ? UserMessage.make({ id: message.id, text: message.text, at })
              : UserMessage.make({
                  id: message.id,
                  text: message.text,
                  attachments: message.attachments,
                  at
                })
          )
          failed = false

          return [message.id]
        },
        AssistantMessage: (message) => {
          sent.set(message.id, message)
          messages.set(message.id, viewOf(message, at))
          failed = false

          return [message.id, ...(message.closes ?? [])]
        },
        BlockAnswer: (answer) => {
          failed = false

          return [answer.messageId]
        },
        BlocksClosed: (closed) => closed.messageIds,
        TurnFailed: () => {
          failed = true

          return []
        },
        ModelOutput: () => [],
        ToolStarted: () => [],
        ToolResult: () => [],
        TurnStarted: () => [],
        TurnCompleted: () => [],
        SpecialistStarted: () => [],
        SpecialistFinished: () => [],
        ChatDeleted: () => {
          deleted = true

          return []
        }
      })
    )

  const step = (entry: AssistantEvent.AnyEntry): Update | undefined => {
    const before = { activity: activityOf(activity), failed, deleted }
    const { event } = entry

    seq = entry.seq
    activity = AssistantActivity.apply(activity, entry)

    if (!AssistantEvent.isLibraryEvent(event)) {
      const row = AppEvent.make({
        id: `app-event:${entry.seq}`,
        tag: event._tag,
        data: AppEvents.toJson(events, event),
        at: entry.at
      })

      messages.set(row.id, row)

      return { seq, messages: [row], activity: activityOf(activity), failed, deleted }
    }

    blocks = BlockKit.apply(blocks, event)

    const changed = [...new Set(touched(event, entry.at))].flatMap((id) => {
      const message = sent.get(id)
      const current = messages.get(id)

      if (message === undefined || current === undefined) return current === undefined ? [] : [current]

      const next = viewOf(message, current.at)
      messages.set(id, next)

      return [next]
    })

    const now = activityOf(activity)

    return changed.length === 0 &&
      failed === before.failed &&
      deleted === before.deleted &&
      sameActivity(before.activity, now)
      ? undefined
      : { seq, messages: changed, activity: now, failed, deleted }
  }

  return {
    step,
    get view() {
      return { seq, messages: [...messages.values()], activity: activityOf(activity), failed, deleted }
    }
  }
}

const merge = (updates: ReadonlyArray<Update>): Update | undefined => {
  const last = updates.at(-1)

  if (last === undefined) return undefined

  const messages = new Map<string, Message>()

  for (const update of updates) for (const message of update.messages) messages.set(message.id, message)

  return {
    seq: last.seq,
    messages: [...messages.values()],
    activity: last.activity,
    failed: last.failed,
    deleted: last.deleted
  }
}

/**
 * Represents an assistant's definition as {@link updates} and {@link fromEntries} read it: the
 * schemas of the app's events, which give each one's JSON form in an {@link AppEvent} row. An
 * assistant made with `Assistant.make` fits it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Definition {
  readonly events: ReadonlyArray<AssistantEvent.AppEventSchema>
}

/**
 * Represents the options accepted by {@link updates}.
 *
 * @category models
 * @since 0.1.0
 */
export interface UpdatesOptions {
  /**
   * The `seq` up to which the client already has the view. The result contains only the updates
   * after it. Defaults to `0`, every update.
   */
  readonly after?: number | undefined
}

/**
 * Returns the stream of view updates that a chat's entries produce, for a chat client.
 *
 * **Details**
 *
 * The entries must stream from the start of the chat's log, as `assistant.subscribe(chatId)` does
 * without `after`. The fold reads every entry, because a message's view depends on earlier
 * entries: a block is answered or closed later. `after` only skips
 * emitting the updates up to that `seq`, so a client that has the view up to a `seq` receives only
 * what changed since. Pass `after` here, not to `subscribe`: a subscription that starts after a
 * `seq` gives the fold an incomplete log, and the updates it produces are wrong.
 *
 * Each chunk of entries becomes one update; the stored entries, for example, arrive as one chunk.
 *
 * **Every app event it gets is shown.** Each one becomes an {@link AppEvent} row between the
 * messages, which the client receives. Filter the stream to the events the chat's user may see
 * before this, or an event that is only for the assistant, like a summary of the chat, reaches the
 * client. A view shows a turn as working once it starts, or from the user's input.
 *
 * **Example** (Streaming a chat's view to a client, with the one app event its user sees)
 *
 * ```ts
 * import { Assistant, AssistantEvent, type ChatId, ChatView } from "effect-assistant"
 * import * as Schema from "effect/Schema"
 * import * as Stream from "effect/Stream"
 *
 * class Summary extends Schema.TaggedClass<Summary>()("Summary", { text: Schema.String, throughSeq: Schema.Int }) {}
 * class DailyBudgetReached extends Schema.TaggedClass<DailyBudgetReached>()("DailyBudgetReached", {}) {}
 *
 * const MyAssistant = Assistant.make("my-assistant", { events: [Summary, DailyBudgetReached] })
 *
 * const watch = (chatId: ChatId.ChatId, after: number) =>
 *   Stream.unwrap(
 *     MyAssistant.useSync((assistant) =>
 *       assistant.subscribe(chatId).pipe(
 *         // The summary is for the model: only the budget notice reaches the user.
 *         Stream.filter(({ event }) => AssistantEvent.isLibraryEvent(event) || Schema.is(DailyBudgetReached)(event)),
 *         ChatView.updates(MyAssistant, { after })
 *       )
 *     )
 *   )
 * ```
 *
 * @see {@link apply} for folding the updates into a view on the client
 *
 * @category utils
 * @since 0.1.0
 */
export const updates: {
  (
    definition: Definition,
    options?: UpdatesOptions
  ): <E, R>(entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>) => Stream.Stream<Update, E, R>
  <E, R>(
    entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
    definition: Definition,
    options?: UpdatesOptions
  ): Stream.Stream<Update, E, R>
} = dual(
  (args) => Stream.isStream(args[0]),
  <E, R>(
    entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
    definition: Definition,
    options?: UpdatesOptions
  ): Stream.Stream<Update, E, R> => {
    const after = options?.after ?? 0

    return entries.pipe(
      Stream.mapAccumArray(
        () => folding(definition.events),
        (fold, chunk) => {
          const changed = chunk.flatMap((entry) => {
            const update = fold.step(entry)

            return update === undefined || entry.seq <= after ? [] : [update]
          })

          const merged = merge(changed)

          return [fold, merged === undefined ? [] : [merged]]
        }
      )
    )
  }
)
