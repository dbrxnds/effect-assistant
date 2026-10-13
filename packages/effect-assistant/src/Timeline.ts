/**
 * This module provides a chat's timeline: the chat as its user sees it. A chat client receives the
 * timeline and nothing else.
 *
 * A {@link Timeline} holds the chat's items: the messages with their blocks, and the app's own
 * events it shows (each typed with its event, see {@link EventItem}). It also holds the chat's
 * {@link Activity}, and whether the last turn failed or the chat was deleted. It never contains the
 * model's output, tool calls or results, what the model read, or why a turn failed. The server
 * streams {@link Change}s by piping the assistant's `subscribe` through {@link changes}, and the
 * client folds them with {@link fold} (or {@link apply}, from {@link empty}). On the server,
 * {@link fromEntries} builds a whole timeline from a chat's log, and {@link snapshot} the whole
 * timeline as one change.
 *
 * **Only the app events in `show` reach the timeline**, and none by default: an event that is only
 * for the assistant, like a summary of the chat, stays out. The RPC's schema, `Change([...])`,
 * names the same events and types the client's timeline with them.
 *
 * @since 0.3.0
 */
import { dual } from "effect/Function"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
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
 * Represents one of the app's own events in the timeline: an item between the messages, in the
 * order the chat stored it.
 *
 * **Details**
 *
 * The item's `_tag` is the event's, so a match over a timeline's items takes a handler per event
 * beside `UserMessage` and `AssistantMessage`. The event, decoded with its schema, is in `event`,
 * and the item's own fields sit beside it rather than spread into it: an event may have an `id` or
 * an `at` of its own, and a class instance keeps its prototype. `id` is fixed per entry of the
 * chat's log, and `at` is when the event was stored, in epoch milliseconds.
 *
 * @category models
 * @since 0.3.0
 */
export type EventItem<E> = E extends { readonly _tag: infer Tag extends string }
  ? { readonly _tag: Tag; readonly id: string; readonly at: number; readonly event: E }
  : never

/**
 * Represents an item in the chat's timeline: a message the user or the assistant sent, or one of
 * the app's own events it shows (see {@link EventItem}).
 *
 * **Example** (Showing each item of a chat)
 *
 * ```ts
 * import { Timeline } from "effect-assistant"
 * import * as Match from "effect/Match"
 * import * as Schema from "effect/Schema"
 *
 * class DailyBudgetReached extends Schema.TaggedClass<DailyBudgetReached>()("DailyBudgetReached", {}) {}
 *
 * const line = (item: Timeline.Item<DailyBudgetReached>) =>
 *   Match.valueTags(item, {
 *     UserMessage: (sent) => `You: ${sent.text}`,
 *     AssistantMessage: (sent) => `Assistant: ${sent.text}`,
 *     DailyBudgetReached: () => "You've reached today's budget."
 *   })
 * ```
 *
 * @category models
 * @since 0.3.0
 */
export type Item<Events = never> = UserMessage | AssistantMessage | EventItem<Events>

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
 * Represents a chat's timeline: the chat as its user sees it, typed with the app's events it shows.
 * It holds the chat's items in order, what is working in it, whether the last turn failed, and
 * whether the chat was deleted. `seq` is the position in the chat's log that the timeline is up to.
 *
 * @category models
 * @since 0.3.0
 */
export interface Timeline<Events = never> {
  readonly seq: number
  readonly items: ReadonlyArray<Item<Events>>
  readonly activity: Activity
  /** Whether the last turn failed with no message after it. */
  readonly failed: boolean
  /** Whether the chat was deleted. A deleted chat accepts nothing more, and its stream ends. */
  readonly deleted: boolean
}

/**
 * Represents a change to a chat's timeline, typed with the app's events it shows.
 *
 * **Details**
 *
 * A change holds each item that is new or changed (for example, a message whose block was
 * answered or closed), in full. It also holds the current activity, whether the last turn failed,
 * and whether the chat was deleted. `seq` is the position in the chat's log that the change is up
 * to.
 *
 * @category models
 * @since 0.3.0
 */
export interface Change<Events = never> {
  readonly seq: number
  readonly items: ReadonlyArray<Item<Events>>
  readonly activity: Activity
  readonly failed: boolean
  readonly deleted: boolean
}

const eventItem = (schema: AssistantEvent.AppEventSchema) =>
  Schema.Struct({ _tag: Schema.Literal(AppEvents.tagOf(schema)), id: Schema.String, at: Schema.Finite, event: schema })

function makeChange<const Events extends ReadonlyArray<AssistantEvent.AppEventSchema> = readonly []>(
  events?: Events
): Schema.Codec<Change<Events[number]["Type"]>, Schema.Json>
// The overload states the decoded type: an item per given schema, each typed with its own event.
function makeChange(events: ReadonlyArray<AssistantEvent.AppEventSchema> = []): Schema.Top {
  const AnyItem = Schema.toCodecJson(Schema.Union([UserMessage, AssistantMessage, ...events.map(eventItem)]))
  const decodeItem = Schema.decodeUnknownOption(AnyItem)
  const encodeItem = Schema.encodeUnknownSync(AnyItem)

  return Schema.Struct({
    seq: Schema.Int,
    // An item for an event this schema doesn't name, or that doesn't decode (from a newer server, say), is left out
    // rather than failing the whole change.
    items: Schema.Array(Schema.Json).pipe(
      Schema.decodeTo(
        Schema.Array(Schema.toType(AnyItem)),
        SchemaTransformation.transform<ReadonlyArray<typeof AnyItem.Type>, ReadonlyArray<Schema.Json>>({
          decode: (json) => json.flatMap((item) => Option.toArray(decodeItem(item))),
          encode: (items) => items.map((item) => encodeItem(item))
        })
      )
    ),
    activity: Activity,
    failed: Schema.Boolean,
    deleted: Schema.Boolean
  })
}

/**
 * Creates the schema for the changes to a chat's timeline, with items for the given app events,
 * in JSON.
 *
 * **Details**
 *
 * It is the success schema of the RPC that streams a chat's timeline: name the events the chat's
 * users see, the same ones the handler passes to {@link changes} as `show`. Each item decodes its
 * event with that event's schema, so the client gets `Change<Events>` typed with them and folds it
 * with {@link fold}, no definition needed. `Change()` carries no app events.
 *
 * A handler whose changes show an event the schema doesn't name doesn't compile.
 *
 * **Example** (An RPC that streams a chat's timeline, with the budget notice)
 *
 * ```ts
 * import { ChatId, Timeline } from "effect-assistant"
 * import * as Rpc from "effect/rpc/Rpc"
 * import * as Schema from "effect/Schema"
 *
 * class DailyBudgetReached extends Schema.TaggedClass<DailyBudgetReached>()("DailyBudgetReached", {}) {}
 *
 * const Subscribe = Rpc.make("Subscribe", {
 *   payload: { chatId: ChatId.ChatId },
 *   success: Timeline.Change([DailyBudgetReached]),
 *   stream: true
 * })
 * ```
 *
 * @category schemas
 * @since 0.3.0
 */
export const Change: <const Events extends ReadonlyArray<AssistantEvent.AppEventSchema> = readonly []>(
  events?: Events
) => Schema.Codec<Change<Events[number]["Type"]>, Schema.Json> = makeChange

/**
 * The timeline of a chat before anything has happened in it, with no items and nothing working.
 * Use it as the starting point when folding changes with {@link apply}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const empty: Timeline = {
  seq: 0,
  items: [],
  activity: { working: false, specialists: [] },
  failed: false,
  deleted: false
}

/**
 * Returns the timeline after a change.
 *
 * **Details**
 *
 * Each item in the change replaces the item with the same id, in place, and new items are added
 * after the rest. The change's activity, `failed`, and `deleted` replace the timeline's. Applying a
 * change twice changes nothing, so a client that resubscribes from the start can fold again and get
 * the same timeline.
 *
 * The timeline is typed with the change's events, as its RPC's schema decoded them (see
 * {@link Change}). To fold a stream of changes, use {@link fold}: in
 * `Stream.scan(() => Timeline.empty, Timeline.apply)`, TypeScript fixes the state's type from
 * `empty` before it sees the changes' events, so that form needs the timeline's type written out.
 *
 * **Example** (Folding changes into your own state)
 *
 * ```ts
 * import { Timeline } from "effect-assistant"
 *
 * interface State<Events> {
 *   readonly timeline: Timeline.Timeline<Events>
 *   readonly unread: number
 * }
 *
 * const next = <Events>(state: State<Events>, change: Timeline.Change<Events>): State<Events> => ({
 *   timeline: Timeline.apply(state.timeline, change),
 *   unread: state.unread + change.items.length
 * })
 * ```
 *
 * @category combinators
 * @since 0.1.0
 */
export const apply = <Events>(timeline: Timeline<Events>, change: Change<Events>): Timeline<Events> => {
  const changed = new Map(change.items.map((item) => [item.id, item]))
  const known = new Set(timeline.items.map((item) => item.id))

  return {
    seq: Math.max(timeline.seq, change.seq),
    items: [
      ...timeline.items.map((item) => changed.get(item.id) ?? item),
      ...change.items.filter((item) => !known.has(item.id))
    ],
    activity: change.activity,
    failed: change.failed,
    deleted: change.deleted
  }
}

/**
 * Returns the timelines a stream of changes folds to, from {@link empty}, typed with the changes'
 * events.
 *
 * **Example** (A chat's timeline on the client)
 *
 * ```ts
 * import { Timeline } from "effect-assistant"
 * import * as Schema from "effect/Schema"
 * import * as Stream from "effect/Stream"
 *
 * class DailyBudgetReached extends Schema.TaggedClass<DailyBudgetReached>()("DailyBudgetReached", {}) {}
 *
 * // The stream of an RPC whose success schema is `Timeline.Change([DailyBudgetReached])`.
 * declare const changes: Stream.Stream<Timeline.Change<DailyBudgetReached>>
 *
 * const timelines = changes.pipe(Timeline.fold) // Stream<Timeline.Timeline<DailyBudgetReached>>
 * ```
 *
 * @category combinators
 * @since 0.3.0
 */
export const fold = <Events, E, R>(
  changes: Stream.Stream<Change<Events>, E, R>
): Stream.Stream<Timeline<Events>, E, R> => changes.pipe(Stream.scan((): Timeline<Events> => empty, apply))

/**
 * Returns whether nothing is working in the chat: no turn is running or about to start, and no
 * specialist is working.
 *
 * @category guards
 * @since 0.1.0
 */
export const isIdle = <Events>(timeline: Timeline<Events>): boolean =>
  !timeline.activity.working && timeline.activity.specialists.length === 0

interface AnyEventItem {
  readonly _tag: string
  readonly id: string
  readonly at: number
  readonly event: { readonly _tag: string }
}

// What the fold below builds: the overloads that use it type its items with the events shown.
interface AnyChange {
  readonly seq: number
  readonly items: ReadonlyArray<UserMessage | AssistantMessage | AnyEventItem>
  readonly activity: Activity
  readonly failed: boolean
  readonly deleted: boolean
}

/**
 * Represents the options for building a chat's timeline from its log.
 *
 * @category models
 * @since 0.3.0
 */
export interface ShowOptions<Show extends ReadonlyArray<AssistantEvent.AppEventSchema>> {
  /**
   * The schemas of the app's events the chat's users see. Each becomes an item in the timeline;
   * the app's other events are left out. Defaults to none.
   */
  readonly show?: Show | undefined
}

/**
 * Represents the schemas an assistant's timeline may show: some of its own events.
 *
 * @category utility types
 * @since 0.3.0
 */
export type Shown<Events> = ReadonlyArray<AssistantEvent.AppEventSchema & { readonly Type: Events }>

function snapshotWith(entries: ReadonlyArray<AssistantEvent.AnyEntry>): Change
function snapshotWith<Events, const Show extends Shown<Events> = readonly []>(
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  definition: Definition<Events>,
  options?: ShowOptions<Show>
): Change<Show[number]["Type"]>
function snapshotWith(
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  _definition?: Schemas,
  options?: ShowOptions<ReadonlyArray<AssistantEvent.AppEventSchema>>
): AnyChange {
  const timeline = folding(options?.show ?? [])

  for (const entry of entries) timeline.step(entry)

  return timeline.snapshot
}

/**
 * Returns a chat's whole timeline as one change, built from the entries of its log.
 *
 * **When to use**
 *
 * Use it on the server for an RPC that returns a whole chat at once: its success schema is
 * {@link Change} with the same events as `show`, and the client applies it to {@link empty}.
 *
 * **Details**
 *
 * Only the app's events in `show` become items; without it, the timeline has none.
 *
 * @category constructors
 * @since 0.3.0
 */
export const snapshot: {
  (entries: ReadonlyArray<AssistantEvent.AnyEntry>): Change
  <Events, const Show extends Shown<Events> = readonly []>(
    entries: ReadonlyArray<AssistantEvent.AnyEntry>,
    definition: Definition<Events>,
    options?: ShowOptions<Show>
  ): Change<Show[number]["Type"]>
} = snapshotWith

function fromEntriesWith(entries: ReadonlyArray<AssistantEvent.AnyEntry>): Timeline
function fromEntriesWith<Events, const Show extends Shown<Events> = readonly []>(
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  definition: Definition<Events>,
  options?: ShowOptions<Show>
): Timeline<Show[number]["Type"]>
function fromEntriesWith(
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  _definition?: Schemas,
  options?: ShowOptions<ReadonlyArray<AssistantEvent.AppEventSchema>>
): AnyChange {
  const timeline = folding(options?.show ?? [])

  for (const entry of entries) timeline.step(entry)

  return timeline.snapshot
}

/**
 * Returns a chat's timeline, built from the entries of its log.
 *
 * **When to use**
 *
 * Use it in server-side code that reads a whole chat. A client gets the timeline as a stream from
 * {@link changes} instead, and an RPC that returns a whole chat sends a {@link snapshot}.
 *
 * **Details**
 *
 * Only the app's events in `show` become items, typed with their schemas; without it, the timeline
 * has none.
 *
 * **Example** (Building a chat's timeline from its log)
 *
 * ```ts
 * import { type ChatId, ChatLog, Timeline } from "effect-assistant"
 * import * as Effect from "effect/Effect"
 *
 * const timelineOf = (chatId: ChatId.ChatId) =>
 *   ChatLog.ChatLog.use((log) => log.read(chatId)).pipe(
 *     Effect.map((entries) => Timeline.fromEntries(entries))
 *   )
 * ```
 *
 * @see {@link changes} for a stream of changes instead of a whole timeline
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromEntries: {
  (entries: ReadonlyArray<AssistantEvent.AnyEntry>): Timeline
  <Events, const Show extends Shown<Events> = readonly []>(
    entries: ReadonlyArray<AssistantEvent.AnyEntry>,
    definition: Definition<Events>,
    options?: ShowOptions<Show>
  ): Timeline<Show[number]["Type"]>
} = fromEntriesWith

interface Schemas {
  readonly events: ReadonlyArray<AssistantEvent.AppEventSchema>
}

interface Folding {
  readonly step: (entry: AssistantEvent.AnyEntry) => AnyChange | undefined
  readonly snapshot: AnyChange
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

const folding = (show: ReadonlyArray<AssistantEvent.AppEventSchema>): Folding => {
  const shown = new Map(show.map((schema) => [AppEvents.tagOf(schema), schema]))
  let seq = 0
  let failed = false
  let deleted = false
  let activity = AssistantActivity.empty
  let blocks: ReadonlyMap<string, BlockKit.State> = new Map()
  // The items in order, and the assistant's messages as stored: their blocks change as the chat goes on.
  const items = new Map<string, UserMessage | AssistantMessage | AnyEventItem>()
  const sent = new Map<string, AssistantEvent.AssistantMessage>()

  const blockOf = (message: AssistantEvent.AssistantMessage): Block | undefined => {
    if (message.block === undefined) return undefined

    const state = blocks.get(message.id)
    const status = state === undefined || state.open ? "open" : state.answer === undefined ? "closed" : "answered"
    const block: Block = { kind: message.block.kind, props: toJson(message.block.props), status }

    return state?.answer === undefined ? block : { ...block, answer: toJson(state.answer.value) }
  }

  const itemOf = (message: AssistantEvent.AssistantMessage, at: number): AssistantMessage => {
    const block = blockOf(message)

    return block === undefined
      ? AssistantMessage.make({ id: message.id, text: message.text, at })
      : AssistantMessage.make({ id: message.id, text: message.text, at, block })
  }

  const touched = (event: AssistantEvent.AssistantEvent, at: number): ReadonlyArray<string> =>
    Match.value(event).pipe(
      Match.tagsExhaustive({
        UserMessage: (message) => {
          items.set(
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
          items.set(message.id, itemOf(message, at))
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

  // Decoded as `subscribe` streams it, or as the log stores it; one that doesn't decode is left out.
  const eventItemOf = (entry: AssistantEvent.AnyEntry): Option.Option<AnyEventItem> => {
    const schema = shown.get(entry.event._tag)

    if (schema === undefined) return Option.none()

    const event = Schema.is(schema)(entry.event) ? Option.some(entry.event) : AppEvents.decodeWith(schema, entry.event)

    return Option.map(event, (decoded) => ({
      _tag: decoded._tag,
      id: `app-event:${entry.seq}`,
      at: entry.at,
      event: decoded
    }))
  }

  const step = (entry: AssistantEvent.AnyEntry): AnyChange | undefined => {
    const before = { activity: activityOf(activity), failed, deleted }
    const { event } = entry

    seq = entry.seq
    activity = AssistantActivity.apply(activity, entry)

    if (!AssistantEvent.isLibraryEvent(event)) {
      const now = activityOf(activity)

      return Option.match(eventItemOf(entry), {
        onNone: () =>
          sameActivity(before.activity, now) ? undefined : { seq, items: [], activity: now, failed, deleted },
        onSome: (item) => {
          items.set(item.id, item)

          return { seq, items: [item], activity: now, failed, deleted }
        }
      })
    }

    blocks = BlockKit.apply(blocks, event)

    const changed = [...new Set(touched(event, entry.at))].flatMap((id) => {
      const message = sent.get(id)
      const current = items.get(id)

      if (message === undefined || current === undefined) return current === undefined ? [] : [current]

      const next = itemOf(message, current.at)
      items.set(id, next)

      return [next]
    })

    const now = activityOf(activity)

    return changed.length === 0 &&
      failed === before.failed &&
      deleted === before.deleted &&
      sameActivity(before.activity, now)
      ? undefined
      : { seq, items: changed, activity: now, failed, deleted }
  }

  return {
    step,
    get snapshot() {
      return { seq, items: [...items.values()], activity: activityOf(activity), failed, deleted }
    }
  }
}

const merge = (changes: ReadonlyArray<AnyChange>): AnyChange | undefined => {
  const last = changes.at(-1)

  if (last === undefined) return undefined

  const items = new Map<string, UserMessage | AssistantMessage | AnyEventItem>()

  for (const change of changes) for (const item of change.items) items.set(item.id, item)

  return {
    seq: last.seq,
    items: [...items.values()],
    activity: last.activity,
    failed: last.failed,
    deleted: last.deleted
  }
}

/**
 * Represents an assistant's definition as the timeline reads it. An assistant made with
 * `Assistant.make` fits it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Definition<Events = never> {
  /** The schemas of the assistant's events. */
  readonly events: ReadonlyArray<AssistantEvent.AppEventSchema>
  /** The schema of the chat's entries, typed with the assistant's events: it types `show`. */
  readonly Entry: Schema.Codec<Assistant.Entry<Events>, Schema.Json>
}

/**
 * Represents the options accepted by {@link changes}.
 *
 * @category models
 * @since 0.3.0
 */
export interface ChangesOptions<
  Show extends ReadonlyArray<AssistantEvent.AppEventSchema> = readonly []
> extends ShowOptions<Show> {
  /**
   * The `seq` up to which the client already has the timeline. The result contains only the
   * changes after it. Defaults to `0`, every change.
   */
  readonly after?: number | undefined
}

function changesWith<E, R, Events, const Show extends Shown<Events> = readonly []>(
  entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
  definition: Definition<Events>,
  options?: ChangesOptions<Show>
): Stream.Stream<Change<Show[number]["Type"]>, E, R>
function changesWith<E, R>(
  entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
  _definition: Schemas,
  options?: ChangesOptions<ReadonlyArray<AssistantEvent.AppEventSchema>>
): Stream.Stream<AnyChange, E, R> {
  const after = options?.after ?? 0

  return entries.pipe(
    Stream.mapAccumArray(
      () => folding(options?.show ?? []),
      (timeline, chunk) => {
        const changed = chunk.flatMap((entry) => {
          const change = timeline.step(entry)

          return change === undefined || entry.seq <= after ? [] : [change]
        })

        const merged = merge(changed)

        return [timeline, merged === undefined ? [] : [merged]]
      }
    )
  )
}

/**
 * Returns the stream of changes to a chat's timeline that its entries produce, for a chat client.
 *
 * **Details**
 *
 * The entries must stream from the start of the chat's log, as `assistant.subscribe(chatId)` does
 * without `after`. The fold reads every entry, because a message depends on earlier entries: its
 * block is answered or closed later. `after` only skips emitting the changes up to that `seq`, so a
 * client that has the timeline up to a `seq` receives only what changed since. Pass `after` here,
 * not to `subscribe`: a subscription that starts after a `seq` gives the fold an incomplete log,
 * and the changes it produces are wrong.
 *
 * Each chunk of entries becomes one change; the stored entries, for example, arrive as one chunk.
 *
 * **Only the app's events in `show` reach the client.** Each one becomes an item between the
 * messages (see {@link EventItem}); the app's other events, like a summary of the chat for the
 * model, are left out. Without `show`, none are shown. The changes are typed with the events shown,
 * so the RPC's success schema names the same ones (`Timeline.Change([...])`), and a handler that
 * shows one the schema doesn't name doesn't compile. A timeline shows a turn as working once it
 * starts, or from the user's input.
 *
 * **Example** (Streaming a chat's timeline to a client, with the one app event its user sees)
 *
 * ```ts
 * import { Assistant, type ChatId, Timeline } from "effect-assistant"
 * import * as Schema from "effect/Schema"
 * import * as Stream from "effect/Stream"
 *
 * class Summary extends Schema.TaggedClass<Summary>()("Summary", { text: Schema.String, throughSeq: Schema.Int }) {}
 * class DailyBudgetReached extends Schema.TaggedClass<DailyBudgetReached>()("DailyBudgetReached", {}) {}
 *
 * const MyAssistant = Assistant.make("my-assistant", { events: [Summary, DailyBudgetReached] })
 *
 * // The summary is for the model: only the budget notice reaches the user.
 * const watch = (chatId: ChatId.ChatId, after: number) =>
 *   Stream.unwrap(
 *     MyAssistant.useSync((assistant) =>
 *       assistant.subscribe(chatId).pipe(Timeline.changes(MyAssistant, { show: [DailyBudgetReached], after }))
 *     )
 *   )
 * ```
 *
 * @see {@link fold} for folding the changes into a timeline on the client
 *
 * @category utils
 * @since 0.3.0
 */
export const changes: {
  <Events, const Show extends Shown<Events> = readonly []>(
    definition: Definition<Events>,
    options?: ChangesOptions<Show>
  ): <E, R>(entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>) => Stream.Stream<Change<Show[number]["Type"]>, E, R>
  <E, R, Events, const Show extends Shown<Events> = readonly []>(
    entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
    definition: Definition<Events>,
    options?: ChangesOptions<Show>
  ): Stream.Stream<Change<Show[number]["Type"]>, E, R>
} = dual((args) => Stream.isStream(args[0]), changesWith)
