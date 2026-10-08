/**
 * This module provides the view of a chat as its user sees it. A chat client receives this view
 * and nothing else.
 *
 * A {@link View} holds the chat's messages with their blocks and decisions, the chat's
 * {@link Activity}, and whether the last turn failed or the chat was deleted. It never contains
 * the model's output, tool calls or results, what the model read, the app's own events, or why a
 * turn failed. The server streams {@link Update}s with `MyAssistant.subscribeView`, which is built
 * on {@link updates}, and the client folds them with {@link apply}, starting from {@link empty}.
 * On the server, {@link fromEntries} builds a whole view from a chat's log.
 *
 * @since 0.1.0
 */
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as AssistantActivity from "./AssistantActivity.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import * as BlockKit from "./BlockKit.ts"
import * as Decisions from "./Decision.ts"
import { DecisionId } from "./DecisionId.ts"
import { InputId } from "./InputId.ts"
import { toJson } from "./internal/schema.ts"

/**
 * Schema for a decision as the user sees it on a decision block. It holds the call the decision is
 * for (its tool and params, which the app can display as it likes) and, once the user has
 * decided, the outcome.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Decision = Schema.Struct({
  id: DecisionId,
  tool: Schema.String,
  params: Schema.Json,
  outcome: Schema.optional(AssistantEvent.DecisionOutcome)
})

/**
 * Represents a decision as the user sees it.
 *
 * @category models
 * @since 0.1.0
 */
export type Decision = typeof Decision.Type

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
 * the block's props schema encodes them), its status, the user's answer (JSON, as the block's
 * answer schema encodes it), and, for a decision block, its decisions.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Block = Schema.Struct({
  kind: Schema.String,
  props: Schema.Json,
  status: BlockStatus,
  answer: Schema.optional(Schema.Json),
  decisions: Schema.optional(Schema.Array(Decision))
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
 * Schema for a message in the chat, sent by either the user or the assistant.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Message = Schema.Union([UserMessage, AssistantMessage])

/**
 * Represents a message in the chat.
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
 * idle, nothing is working, even if a workflow is waiting on a timer or a decision.
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
 * Schema for a chat as its user sees it. It holds the chat's messages, what is working in it,
 * whether the last turn failed, and whether the chat was deleted. `seq` is the position in the
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
 * An update holds each message that is new or changed (for example, a block answered or closed,
 * or a decision made), in full. It also holds the current activity, whether the last turn failed,
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
 * Represents the options for building a view from a chat's log.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The tags of the app's events that wake a turn. After such an event, the view shows a turn as
   * about to start. Defaults to none.
   */
  readonly wakes?: ReadonlySet<string> | undefined
}

/**
 * Returns a chat's view, built from the entries of its log.
 *
 * **When to use**
 *
 * Use it in server-side code, for example to return a whole chat at once. A client gets the view
 * from `MyAssistant.subscribeView` instead, which knows the assistant's events.
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
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, options?: Options): View => {
  const fold = folding(options?.wakes ?? new Set())

  for (const entry of entries) fold.step(entry)

  return fold.view
}

interface Folding {
  readonly step: (entry: AssistantEvent.AnyEntry) => Update | undefined
  readonly view: View
}

const decodeProps = Schema.decodeUnknownOption(Decisions.Props)

const decodeAnswer = Schema.decodeUnknownOption(Decisions.Answer)

const activityOf = (activity: AssistantActivity.Activity): Activity => ({
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

const decisionIds = (block: AssistantEvent.MessageBlock): ReadonlyArray<string> =>
  block.kind === Decisions.kind
    ? Option.match(decodeProps(block.props), {
        onNone: () => [],
        onSome: (props) => props.decisionIds
      })
    : []

const folding = (wakes: ReadonlySet<string>): Folding => {
  let seq = 0
  let failed = false
  let deleted = false
  let activity = AssistantActivity.empty
  let blocks: ReadonlyMap<string, BlockKit.BlockState> = new Map()
  let decisions: ReadonlyMap<string, Decisions.State> = new Map()
  // The messages in order, and the assistant's as stored: their blocks change as the chat goes on.
  const messages = new Map<string, Message>()
  const sent = new Map<string, AssistantEvent.AssistantMessage>()
  // Which messages ask for a decision, so a decision's outcome updates the block that asked for it.
  const asking = new Map<string, Array<string>>()

  const blockOf = (message: AssistantEvent.AssistantMessage): Block | undefined => {
    if (message.block === undefined) return undefined

    const state = blocks.get(message.id)
    const status = state === undefined || state.open ? "open" : state.answer === undefined ? "closed" : "answered"
    const ids = decisionIds(message.block)

    const shown = ids.flatMap((id) => {
      const decision = decisions.get(id)

      if (decision === undefined) return []

      const { tool, params } = decision.request.origin
      const shown = { id: decision.request.id, tool, params }

      return [decision.outcome === undefined ? shown : { ...shown, outcome: decision.outcome }]
    })

    const block: Block = { kind: message.block.kind, props: toJson(message.block.props), status }
    const answered = state?.answer === undefined ? block : { ...block, answer: toJson(state.answer.value) }

    return message.block.kind === Decisions.kind ? { ...answered, decisions: shown } : answered
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

          if (message.block !== undefined) {
            for (const id of decisionIds(message.block)) asking.set(id, [...(asking.get(id) ?? []), message.id])
          }

          return [message.id, ...(message.closes ?? [])]
        },
        BlockAnswer: (answer) => {
          failed = false

          const decided =
            answer.kind === Decisions.kind
              ? Option.match(decodeAnswer(answer.value), {
                  onNone: () => [],
                  onSome: ({ decisions }) => Object.keys(decisions).flatMap((id) => asking.get(id) ?? [])
                })
              : []

          return [answer.messageId, ...decided]
        },
        BlocksClosed: (closed) => closed.messageIds,
        DecisionResolved: (resolved) => asking.get(resolved.id) ?? [],
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
        DecisionRequested: () => [],
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
    activity = AssistantActivity.apply(activity, entry, { wakes })

    if (!AssistantEvent.isLibraryEvent(event)) {
      const now = activityOf(activity)

      return sameActivity(before.activity, now) ? undefined : { seq, messages: [], activity: now, failed, deleted }
    }

    blocks = BlockKit.nextBlockStates(blocks, event)
    decisions = Decisions.apply(decisions, event)

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
 * Returns the stream of updates that a chat's entries produce.
 *
 * **Details**
 *
 * `entries` must stream from the start of the chat's log, as `MyAssistant.subscribe` does. The
 * result contains only the updates after `after`, and each chunk of entries becomes one update;
 * the stored entries, for example, arrive as one chunk. `MyAssistant.subscribeView` is this
 * function applied to the assistant's log.
 *
 * **Example** (Folding a chat's log into its view)
 *
 * ```ts
 * import { Assistant, type ChatId, ChatView } from "effect-assistant"
 * import * as Stream from "effect/Stream"
 *
 * const MyAssistant = Assistant.make("my-assistant")
 *
 * const watch = (chatId: ChatId.ChatId) =>
 *   Stream.unwrap(
 *     MyAssistant.useSync((assistant) =>
 *       ChatView.updates(assistant.subscribe(chatId)).pipe(
 *         Stream.scan(() => ChatView.empty, ChatView.apply)
 *       )
 *     )
 *   )
 * ```
 *
 * @see {@link apply} for folding the updates into a view
 *
 * @category utils
 * @since 0.1.0
 */
export const updates = <E, R>(
  entries: Stream.Stream<AssistantEvent.AnyEntry, E, R>,
  options?: Options & { readonly after?: number | undefined }
): Stream.Stream<Update, E, R> => {
  const after = options?.after ?? 0

  return entries.pipe(
    Stream.mapAccumArray(
      () => folding(options?.wakes ?? new Set()),
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
