/**
 * This module provides the view of a chat as its user sees it. A chat client receives this view
 * and nothing else.
 *
 * A {@link View} holds the chat's messages with their blocks, the assistant's own events it was
 * given (each a row typed with the assistant's events, see {@link EventRow}), the chat's
 * {@link Activity}, and whether the last turn failed or the chat was deleted. It never contains the
 * model's output, tool calls or results, what the model read, or why a turn failed. The server
 * streams {@link Update}s, which are JSON, by piping the assistant's `subscribe` through
 * {@link updates}, and the client folds them with `apply(MyAssistant)`, which decodes the events,
 * starting from {@link empty}. On the server, {@link fromEntries} builds a whole view from a
 * chat's log, and {@link snapshot} the whole view as one update.
 *
 * **The view shows every app event it gets.** Filter the entries to the events the chat's user may
 * see before they reach {@link updates}, {@link snapshot}, or {@link fromEntries}: an event that is only for the
 * assistant, like a summary of the chat, would reach the client otherwise.
 *
 * @since 0.1.0
 */
import { dual } from "effect/Function"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as Assistant from "./Assistant.ts"
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
 * Represents one of the assistant's own events in the view: a row between the messages, in the
 * order the chat stored it.
 *
 * **Details**
 *
 * The row's `_tag` is the event's, so a match over a view's messages takes a handler per event
 * beside `UserMessage` and `AssistantMessage`. The event, decoded with its schema, is in `event`,
 * and the row's own fields sit beside it rather than spread into it: an event may have an `id` or
 * an `at` of its own, and a class instance keeps its prototype. `id` is fixed per entry of the
 * chat's log, and `at` is when the event was stored, in epoch milliseconds.
 *
 * @category models
 * @since 0.3.0
 */
export type EventRow<E> = E extends { readonly _tag: infer Tag extends string }
  ? { readonly _tag: Tag; readonly id: string; readonly at: number; readonly event: E }
  : never

/**
 * Represents an item in the chat as its user sees it: a message the user or the assistant sent,
 * or one of the assistant's own events (see {@link EventRow}), typed with the assistant's events.
 *
 * **Example** (Showing each item of a chat)
 *
 * ```ts
 * import { Assistant, ChatView } from "effect-assistant"
 * import * as Match from "effect/Match"
 * import * as Schema from "effect/Schema"
 *
 * class DailyBudgetReached extends Schema.TaggedClass<DailyBudgetReached>()("DailyBudgetReached", {}) {}
 *
 * const MyAssistant = Assistant.make("my-assistant", { events: [DailyBudgetReached] })
 *
 * const line = (message: ChatView.Message<DailyBudgetReached>) =>
 *   Match.valueTags(message, {
 *     UserMessage: (sent) => `You: ${sent.text}`,
 *     AssistantMessage: (sent) => `Assistant: ${sent.text}`,
 *     DailyBudgetReached: () => "You've reached today's budget."
 *   })
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export type Message<Events = never> = UserMessage | AssistantMessage | EventRow<Events>

// On the wire an event's row holds the event in its JSON form, so an update needs no definition to
// decode; `apply` decodes the event with the definition's schemas.
const EncodedEventRow = Schema.Struct({
  _tag: Schema.String,
  id: Schema.String,
  at: Schema.Finite,
  event: Schema.Json
})

const EncodedMessage = Schema.Union([UserMessage, AssistantMessage, EncodedEventRow])

type EncodedMessage = typeof EncodedMessage.Type

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
 * Represents a chat as its user sees it, typed with the assistant's events. It holds the chat's
 * messages and the assistant's events it was given, in order, what is working in it, whether the
 * last turn failed, and whether the chat was deleted. `seq` is the position in the chat's log that
 * the view is up to.
 *
 * @category models
 * @since 0.1.0
 */
export interface View<Events = never> {
  readonly seq: number
  readonly messages: ReadonlyArray<Message<Events>>
  readonly activity: Activity
  /** Whether the last turn failed with no message after it. */
  readonly failed: boolean
  /** Whether the chat was deleted. A deleted chat accepts nothing more, and its stream ends. */
  readonly deleted: boolean
}

/**
 * Schema for a change to a chat's view, as it goes over the wire.
 *
 * **Details**
 *
 * An update holds each message that is new or changed (for example, a block answered or
 * closed), in full. It also holds the current activity, whether the last turn failed,
 * and whether the chat was deleted. `seq` is the position in the chat's log that the update is up
 * to.
 *
 * It is JSON and needs no definition, so it serves as an RPC's success schema as it is. A row for
 * one of the assistant's events holds the event in its JSON form; the client's {@link apply}
 * decodes it with the assistant's schemas.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Update = Schema.Struct({
  seq: Schema.Int,
  messages: Schema.Array(EncodedMessage),
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
 * Use it as the starting point when folding updates with {@link apply}, for any assistant.
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

interface DecodedRow {
  readonly _tag: string
  readonly id: string
  readonly at: number
  readonly event: { readonly _tag: string }
}

// The view as the implementations below build it: their overloads type its rows with the assistant's events.
interface AnyView {
  readonly seq: number
  readonly messages: ReadonlyArray<UserMessage | AssistantMessage | DecodedRow>
  readonly activity: Activity
  readonly failed: boolean
  readonly deleted: boolean
}

interface Schemas {
  readonly events: ReadonlyArray<AssistantEvent.AppEventSchema>
}

const applyWith = (definition: Schemas): ((view: AnyView, update: Update) => AnyView) => {
  const decoders = new Map(
    definition.events.map((schema) => [AppEvents.tagOf(schema), Schema.decodeUnknownOption(Schema.toCodecJson(schema))])
  )

  // A row whose event the definition doesn't know, or that doesn't decode, is left out: the view goes on without it.
  const decoded = (message: EncodedMessage): ReadonlyArray<UserMessage | AssistantMessage | DecodedRow> => {
    if (Predicate.isTagged(message, "UserMessage") || Predicate.isTagged(message, "AssistantMessage")) return [message]

    const decode = decoders.get(message._tag)

    return decode === undefined
      ? []
      : Option.toArray(Option.map(decode(message.event), (event) => ({ ...message, event })))
  }

  return (view, update) => {
    const messages = update.messages.flatMap(decoded)
    const changed = new Map(messages.map((message) => [message.id, message]))
    const known = new Set(view.messages.map((message) => message.id))

    return {
      seq: Math.max(view.seq, update.seq),
      messages: [
        ...view.messages.map((message) => changed.get(message.id) ?? message),
        ...messages.filter((message) => !known.has(message.id))
      ],
      activity: update.activity,
      failed: update.failed,
      deleted: update.deleted
    }
  }
}

function typedApply<Events>(definition: Definition<Events>): (view: View<Events>, update: Update) => View<Events>
function typedApply(definition: Schemas): (view: AnyView, update: Update) => AnyView {
  return applyWith(definition)
}

/**
 * Returns a function that applies an update to a view, decoding the rows of the assistant's events
 * with its schemas.
 *
 * **Details**
 *
 * Each message in the update replaces the message with the same id, in place, and new messages
 * are added after the rest. The update's activity, `failed`, and `deleted` replace the view's.
 * Applying an update twice changes nothing, so a client that resubscribes from the start can fold
 * again and get the same view.
 *
 * A row for one of the assistant's events becomes the event, decoded, typed with the definition's
 * events (see {@link EventRow}). A row whose tag the definition doesn't have, or whose event
 * doesn't decode, is left out.
 *
 * **Example** (Folding a chat's updates on the client)
 *
 * ```ts
 * import { Assistant, ChatView } from "effect-assistant"
 * import * as Stream from "effect/Stream"
 *
 * const MyAssistant = Assistant.make("my-assistant")
 *
 * declare const updates: Stream.Stream<ChatView.Update>
 *
 * const views = updates.pipe(Stream.scan(() => ChatView.empty, ChatView.apply(MyAssistant)))
 * ```
 *
 * @category combinators
 * @since 0.1.0
 */
export const apply: <Events>(definition: Definition<Events>) => (view: View<Events>, update: Update) => View<Events> =
  typedApply

/**
 * Returns whether nothing is working in the chat: no turn is running or about to start, and no
 * specialist is working.
 *
 * @category guards
 * @since 0.1.0
 */
export const isIdle = <Events>(view: View<Events>): boolean =>
  !view.activity.working && view.activity.specialists.length === 0

/**
 * Returns a chat's whole view as one update, built from the entries of its log.
 *
 * **When to use**
 *
 * Use it on the server for an RPC that returns a whole chat at once: the RPC's success schema is
 * {@link Update}, and the client applies it to {@link empty} with {@link apply}.
 *
 * **Details**
 *
 * Every app event among the entries becomes a row, so pass only those the user may see. The
 * definition's schemas give a decoded event its JSON form; without one, an event is taken as it is
 * stored, as `ChatLog.read` returns it.
 *
 * @category constructors
 * @since 0.3.0
 */
export const snapshot = <Events>(
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  definition?: Definition<Events>
): Update => snapshotWith(entries, definition ?? noEvents)

const snapshotWith = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, definition: Schemas): Update => {
  const fold = folding(definition.events)

  for (const entry of entries) fold.step(entry)

  return fold.snapshot
}

const noEvents: Schemas = { events: [] }

function fromEntriesWith(entries: ReadonlyArray<AssistantEvent.AnyEntry>): View
function fromEntriesWith<Events>(
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  definition: Definition<Events>
): View<Events>
function fromEntriesWith(entries: ReadonlyArray<AssistantEvent.AnyEntry>, definition?: Schemas): AnyView {
  const schemas = definition ?? noEvents

  return applyWith(schemas)(empty, snapshotWith(entries, schemas))
}

/**
 * Returns a chat's view, built from the entries of its log, typed with the assistant's events.
 *
 * **When to use**
 *
 * Use it in server-side code that reads a whole chat. A client gets the view as a stream from
 * {@link updates} instead, and an RPC that returns a whole chat sends a {@link snapshot}.
 *
 * **Details**
 *
 * Every app event among the entries becomes a row, so pass only those the user may see. Without a
 * definition, the view has no rows for app events.
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
export const fromEntries: {
  (entries: ReadonlyArray<AssistantEvent.AnyEntry>): View
  <Events>(entries: ReadonlyArray<AssistantEvent.AnyEntry>, definition: Definition<Events>): View<Events>
} = fromEntriesWith

interface Folding {
  readonly step: (entry: AssistantEvent.AnyEntry) => Update | undefined
  readonly snapshot: Update
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
  const messages = new Map<string, EncodedMessage>()
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
      const row = EncodedEventRow.make({
        _tag: event._tag,
        id: `app-event:${entry.seq}`,
        at: entry.at,
        event: AppEvents.toJson(events, event)
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
    get snapshot() {
      return { seq, messages: [...messages.values()], activity: activityOf(activity), failed, deleted }
    }
  }
}

const merge = (updates: ReadonlyArray<Update>): Update | undefined => {
  const last = updates.at(-1)

  if (last === undefined) return undefined

  const messages = new Map<string, EncodedMessage>()

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
 * Represents an assistant's definition as the view reads it. An assistant made with
 * `Assistant.make` fits it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Definition<Events = never> {
  /** The schemas of the assistant's events, which encode and decode their rows. */
  readonly events: ReadonlyArray<AssistantEvent.AppEventSchema>
  /** The schema of the chat's entries, typed with the assistant's events: it types the rows. */
  readonly Entry: Schema.Codec<Assistant.Entry<Events>, Schema.Json>
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
 * **Every app event it gets is shown.** Each one becomes a row between the messages (see
 * {@link EventRow}), which the client receives. Filter the stream to the events the chat's user may see
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
  <Events>(
    definition: Definition<Events>,
    options?: UpdatesOptions
  ): <E, R>(entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>) => Stream.Stream<Update, E, R>
  <E, R, Events>(
    entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
    definition: Definition<Events>,
    options?: UpdatesOptions
  ): Stream.Stream<Update, E, R>
} = dual(
  (args) => Stream.isStream(args[0]),
  <E, R>(
    entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
    definition: Schemas,
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
