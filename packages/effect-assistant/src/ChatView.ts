/**
 * This module provides the view of a chat as its user sees it. A chat client receives this view
 * and nothing else.
 *
 * A {@link View} holds the chat's messages with their blocks, the app's own events it shows (each
 * a row typed with its event, see {@link EventRow}), the chat's {@link Activity}, and whether the
 * last turn failed or the chat was deleted. It never contains the model's output, tool calls or
 * results, what the model read, or why a turn failed. The server streams {@link Update}s by piping
 * the assistant's `subscribe` through {@link updates}, and the client folds them with
 * {@link views} (or {@link apply}, from {@link empty}). On the server, {@link fromEntries} builds a
 * whole view from a chat's log, and {@link snapshot} the whole view as one update.
 *
 * **Only the app events in `show` reach the view**, and none by default: an event that is only for
 * the assistant, like a summary of the chat, stays out. The RPC's schema, `Update([...])`, names
 * the same events and types the client's view with them.
 *
 * @since 0.1.0
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
 * Represents a change to a chat's view, typed with the app's events it shows.
 *
 * **Details**
 *
 * An update holds each message that is new or changed (for example, a block answered or
 * closed), in full, and a row for each of the shown app events that is new. It also holds the
 * current activity, whether the last turn failed, and whether the chat was deleted. `seq` is the
 * position in the chat's log that the update is up to.
 *
 * @category models
 * @since 0.1.0
 */
export interface Update<Events = never> {
  readonly seq: number
  readonly messages: ReadonlyArray<Message<Events>>
  readonly activity: Activity
  readonly failed: boolean
  readonly deleted: boolean
}

const eventRow = (schema: AssistantEvent.AppEventSchema) =>
  Schema.Struct({ _tag: Schema.Literal(AppEvents.tagOf(schema)), id: Schema.String, at: Schema.Finite, event: schema })

function makeUpdate<const Events extends ReadonlyArray<AssistantEvent.AppEventSchema> = readonly []>(
  events?: Events
): Schema.Codec<Update<Events[number]["Type"]>, Schema.Json>
// The overload states the decoded type: a row per given schema, each typed with its own event.
function makeUpdate(events: ReadonlyArray<AssistantEvent.AppEventSchema> = []): Schema.Top {
  const Item = Schema.toCodecJson(Schema.Union([UserMessage, AssistantMessage, ...events.map(eventRow)]))
  const decodeItem = Schema.decodeUnknownOption(Item)
  const encodeItem = Schema.encodeUnknownSync(Item)

  return Schema.Struct({
    seq: Schema.Int,
    // A row for an event this schema doesn't name, or that doesn't decode (from a newer server, say), is left out
    // rather than failing the whole update.
    messages: Schema.Array(Schema.Json).pipe(
      Schema.decodeTo(
        Schema.Array(Schema.toType(Item)),
        SchemaTransformation.transform<ReadonlyArray<typeof Item.Type>, ReadonlyArray<Schema.Json>>({
          decode: (items) => items.flatMap((item) => Option.toArray(decodeItem(item))),
          encode: (messages) => messages.map((message) => encodeItem(message))
        })
      )
    ),
    activity: Activity,
    failed: Schema.Boolean,
    deleted: Schema.Boolean
  })
}

/**
 * Creates the schema for a chat's view updates, with rows for the given app events, in JSON.
 *
 * **Details**
 *
 * It is the success schema of the RPC that streams a chat's view: name the events the chat's users
 * see, the same ones the handler passes to {@link updates} as `show`. Each row decodes its event
 * with that event's schema, so the client gets `Update<Events>` typed with them, and folds it with
 * {@link apply}, no definition needed. `Update()` carries no app events.
 *
 * A handler whose updates show an event the schema doesn't name doesn't compile.
 *
 * **Example** (An RPC that streams a chat's view, with the budget notice)
 *
 * ```ts
 * import { ChatId, ChatView } from "effect-assistant"
 * import * as Rpc from "effect/rpc/Rpc"
 * import * as Schema from "effect/Schema"
 *
 * class DailyBudgetReached extends Schema.TaggedClass<DailyBudgetReached>()("DailyBudgetReached", {}) {}
 *
 * const Subscribe = Rpc.make("Subscribe", {
 *   payload: { chatId: ChatId.ChatId },
 *   success: ChatView.Update([DailyBudgetReached]),
 *   stream: true
 * })
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const Update: <const Events extends ReadonlyArray<AssistantEvent.AppEventSchema> = readonly []>(
  events?: Events
) => Schema.Codec<Update<Events[number]["Type"]>, Schema.Json> = makeUpdate

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
 * and rows are added after the rest. The update's activity, `failed`, and `deleted` replace the
 * view's. Applying an update twice changes nothing, so a client that resubscribes from the start
 * can fold again and get the same view.
 *
 * The view is typed with the update's events, as its RPC's schema decoded them (see
 * {@link Update}). To fold a stream of updates, use {@link views}: in
 * `Stream.scan(() => ChatView.empty, ChatView.apply)`, TypeScript fixes the state's type from
 * `empty` before it sees the updates' events, so that form needs the view's type written out.
 *
 * **Example** (Folding updates into your own state)
 *
 * ```ts
 * import { ChatView } from "effect-assistant"
 *
 * interface State<Events> {
 *   readonly view: ChatView.View<Events>
 *   readonly unread: number
 * }
 *
 * const next = <Events>(state: State<Events>, update: ChatView.Update<Events>): State<Events> => ({
 *   view: ChatView.apply(state.view, update),
 *   unread: state.unread + update.messages.length
 * })
 * ```
 *
 * @category combinators
 * @since 0.1.0
 */
export const apply = <Events>(view: View<Events>, update: Update<Events>): View<Events> => {
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
 * Returns the views a stream of updates folds to, from {@link empty}, typed with the updates'
 * events.
 *
 * **Example** (A chat's view on the client)
 *
 * ```ts
 * import { ChatId, ChatView } from "effect-assistant"
 * import * as Rpc from "effect/rpc/Rpc"
 * import * as RpcGroup from "effect/rpc/RpcGroup"
 * import * as Schema from "effect/Schema"
 * import * as Stream from "effect/Stream"
 *
 * class DailyBudgetReached extends Schema.TaggedClass<DailyBudgetReached>()("DailyBudgetReached", {}) {}
 *
 * const Rpcs = RpcGroup.make(
 *   Rpc.make("Subscribe", { payload: { chatId: ChatId.ChatId }, success: ChatView.Update([DailyBudgetReached]), stream: true })
 * )
 *
 * declare const updates: Stream.Stream<ChatView.Update<DailyBudgetReached>> // the RPC's stream
 *
 * const views = updates.pipe(ChatView.views) // Stream<ChatView.View<DailyBudgetReached>>
 * ```
 *
 * @category combinators
 * @since 0.3.0
 */
export const views = <Events, E, R>(updates: Stream.Stream<Update<Events>, E, R>): Stream.Stream<View<Events>, E, R> =>
  updates.pipe(Stream.scan((): View<Events> => empty, apply))

/**
 * Returns whether nothing is working in the chat: no turn is running or about to start, and no
 * specialist is working.
 *
 * @category guards
 * @since 0.1.0
 */
export const isIdle = <Events>(view: View<Events>): boolean =>
  !view.activity.working && view.activity.specialists.length === 0

interface Row {
  readonly _tag: string
  readonly id: string
  readonly at: number
  readonly event: { readonly _tag: string }
}

// What the fold below builds: the overloads that use it type its rows with the events shown.
interface AnyUpdate {
  readonly seq: number
  readonly messages: ReadonlyArray<UserMessage | AssistantMessage | Row>
  readonly activity: Activity
  readonly failed: boolean
  readonly deleted: boolean
}

/**
 * Represents the options for building a chat's view from its log.
 *
 * @category models
 * @since 0.3.0
 */
export interface ShowOptions<Show extends ReadonlyArray<AssistantEvent.AppEventSchema>> {
  /**
   * The schemas of the app's events the chat's users see. Each becomes a row in the view; the
   * app's other events are left out. Defaults to none.
   */
  readonly show?: Show | undefined
}

/**
 * Represents the schemas an assistant's view may show: some of its own events.
 *
 * @category utility types
 * @since 0.3.0
 */
export type Shown<Events> = ReadonlyArray<AssistantEvent.AppEventSchema & { readonly Type: Events }>

function snapshotWith(entries: ReadonlyArray<AssistantEvent.AnyEntry>): Update
function snapshotWith<Events, const Show extends Shown<Events> = readonly []>(
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  definition: Definition<Events>,
  options?: ShowOptions<Show>
): Update<Show[number]["Type"]>
function snapshotWith(
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  _definition?: Schemas,
  options?: ShowOptions<ReadonlyArray<AssistantEvent.AppEventSchema>>
): AnyUpdate {
  const fold = folding(options?.show ?? [])

  for (const entry of entries) fold.step(entry)

  return fold.snapshot
}

/**
 * Returns a chat's whole view as one update, built from the entries of its log.
 *
 * **When to use**
 *
 * Use it on the server for an RPC that returns a whole chat at once: its success schema is
 * {@link Update} with the same events as `show`, and the client applies it to {@link empty}.
 *
 * **Details**
 *
 * Only the app's events in `show` become rows; without it, the view has none.
 *
 * @category constructors
 * @since 0.3.0
 */
export const snapshot: {
  (entries: ReadonlyArray<AssistantEvent.AnyEntry>): Update
  <Events, const Show extends Shown<Events> = readonly []>(
    entries: ReadonlyArray<AssistantEvent.AnyEntry>,
    definition: Definition<Events>,
    options?: ShowOptions<Show>
  ): Update<Show[number]["Type"]>
} = snapshotWith

function fromEntriesWith(entries: ReadonlyArray<AssistantEvent.AnyEntry>): View
function fromEntriesWith<Events, const Show extends Shown<Events> = readonly []>(
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  definition: Definition<Events>,
  options?: ShowOptions<Show>
): View<Show[number]["Type"]>
function fromEntriesWith(
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  _definition?: Schemas,
  options?: ShowOptions<ReadonlyArray<AssistantEvent.AppEventSchema>>
): AnyUpdate {
  const fold = folding(options?.show ?? [])

  for (const entry of entries) fold.step(entry)

  return fold.snapshot
}

/**
 * Returns a chat's view, built from the entries of its log.
 *
 * **When to use**
 *
 * Use it in server-side code that reads a whole chat. A client gets the view as a stream from
 * {@link updates} instead, and an RPC that returns a whole chat sends a {@link snapshot}.
 *
 * **Details**
 *
 * Only the app's events in `show` become rows, typed with their schemas; without it, the view has
 * none.
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
  <Events, const Show extends Shown<Events> = readonly []>(
    entries: ReadonlyArray<AssistantEvent.AnyEntry>,
    definition: Definition<Events>,
    options?: ShowOptions<Show>
  ): View<Show[number]["Type"]>
} = fromEntriesWith

interface Schemas {
  readonly events: ReadonlyArray<AssistantEvent.AppEventSchema>
}

interface Folding {
  readonly step: (entry: AssistantEvent.AnyEntry) => AnyUpdate | undefined
  readonly snapshot: AnyUpdate
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
  // The messages in order, and the assistant's as stored: their blocks change as the chat goes on.
  const messages = new Map<string, UserMessage | AssistantMessage | Row>()
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

  // Decoded as `subscribe` streams it, or as the log stores it; one that doesn't decode is left out.
  const rowOf = (entry: AssistantEvent.AnyEntry): Option.Option<Row> => {
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

  const step = (entry: AssistantEvent.AnyEntry): AnyUpdate | undefined => {
    const before = { activity: activityOf(activity), failed, deleted }
    const { event } = entry

    seq = entry.seq
    activity = AssistantActivity.apply(activity, entry)

    if (!AssistantEvent.isLibraryEvent(event)) {
      const now = activityOf(activity)

      return Option.match(rowOf(entry), {
        onNone: () =>
          sameActivity(before.activity, now) ? undefined : { seq, messages: [], activity: now, failed, deleted },
        onSome: (row) => {
          messages.set(row.id, row)

          return { seq, messages: [row], activity: now, failed, deleted }
        }
      })
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

const merge = (updates: ReadonlyArray<AnyUpdate>): AnyUpdate | undefined => {
  const last = updates.at(-1)

  if (last === undefined) return undefined

  const messages = new Map<string, UserMessage | AssistantMessage | Row>()

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
export interface UpdatesOptions<
  Show extends ReadonlyArray<AssistantEvent.AppEventSchema> = readonly []
> extends ShowOptions<Show> {
  /**
   * The `seq` up to which the client already has the view. The result contains only the updates
   * after it. Defaults to `0`, every update.
   */
  readonly after?: number | undefined
}

function updatesWith<E, R, Events, const Show extends Shown<Events> = readonly []>(
  entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
  definition: Definition<Events>,
  options?: UpdatesOptions<Show>
): Stream.Stream<Update<Show[number]["Type"]>, E, R>
function updatesWith<E, R>(
  entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
  _definition: Schemas,
  options?: UpdatesOptions<ReadonlyArray<AssistantEvent.AppEventSchema>>
): Stream.Stream<AnyUpdate, E, R> {
  const after = options?.after ?? 0

  return entries.pipe(
    Stream.mapAccumArray(
      () => folding(options?.show ?? []),
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
 * **Only the app's events in `show` reach the client.** Each one becomes a row between the
 * messages (see {@link EventRow}); the app's other events, like a summary of the chat for the
 * model, are left out. Without `show`, none are shown. The updates are typed with the events shown,
 * so the RPC's success schema names the same ones (`ChatView.Update([...])`), and a handler that
 * shows one the schema doesn't name doesn't compile. A view shows a turn as working once it
 * starts, or from the user's input.
 *
 * **Example** (Streaming a chat's view to a client, with the one app event its user sees)
 *
 * ```ts
 * import { Assistant, type ChatId, ChatView } from "effect-assistant"
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
 *       assistant.subscribe(chatId).pipe(ChatView.updates(MyAssistant, { show: [DailyBudgetReached], after }))
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
  <Events, const Show extends Shown<Events> = readonly []>(
    definition: Definition<Events>,
    options?: UpdatesOptions<Show>
  ): <E, R>(entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>) => Stream.Stream<Update<Show[number]["Type"]>, E, R>
  <E, R, Events, const Show extends Shown<Events> = readonly []>(
    entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
    definition: Definition<Events>,
    options?: UpdatesOptions<Show>
  ): Stream.Stream<Update<Show[number]["Type"]>, E, R>
} = dual((args) => Stream.isStream(args[0]), updatesWith)
