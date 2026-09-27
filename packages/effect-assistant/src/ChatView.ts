/**
 * The `ChatView` module is a chat as its user sees it: what a chat client
 * gets, and all it gets.
 *
 * - **Messages**: the user's, and the assistant's (what it sent with
 *   `send_user_message`), in order.
 * - **Blocks** on the assistant's messages: their props, whether they're
 *   open, answered (with the answer), or closed, and, for a decision block,
 *   each decision's preview and outcome.
 * - **Activity**: whether the assistant is working (a turn, or one about to
 *   start) and which specialists are, for a working indicator, and the
 *   message it's writing to the user right now, for typing dots (and its
 *   text so far, for a client that shows it as it's written).
 * - Whether the last turn **failed**, until the next message.
 *
 * Nothing else: not the model's output, tool calls or results, what the
 * model read, the app's own events, or why a turn failed. The chat's log
 * (`MyAssistant.subscribe`) has those, for server-side code.
 *
 * `MyAssistant.subscribeView(chatId)` streams {@link Update}s: each one has
 * the messages that are new or changed since the last, and the activity now.
 * A client folds them with {@link apply}, from {@link empty}; an update
 * that's applied twice changes nothing, so a client that resubscribes from
 * the start just folds again. Both are schemas: {@link Update} for the RPC
 * that streams them, and {@link View} for one that returns a whole chat.
 *
 * **Example** (A chat's view over RPC)
 *
 * ```ts
 * import { ChatId, ChatView } from "effect-assistant"
 * import * as Rpc from "effect/unstable/rpc/Rpc"
 *
 * // Shared by the server and the client.
 * export const Subscribe = Rpc.make("Subscribe", {
 *   payload: { chatId: ChatId.ChatId },
 *   success: ChatView.Update,
 *   stream: true
 * })
 *
 * // The server, once it checked the user may read the chat:
 * const handlers = { Subscribe: ({ chatId }) => MyAssistant.subscribeView(chatId) }
 *
 * // The client:
 * const view = client("Subscribe", { chatId }).pipe(Stream.scan(() => ChatView.empty, ChatView.apply))
 * ```
 *
 * @since 0.1.0
 */
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
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
 * Schema for a decision as the user sees it on a decision block: what they
 * decide on (the preview), and how they decided, once they did.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Decision = Schema.Struct({
  id: DecisionId,
  preview: Schema.Json,
  outcome: Schema.optional(AssistantEvent.DecisionOutcome)
})

/**
 * A decision as the user sees it.
 *
 * @category models
 * @since 0.1.0
 */
export type Decision = typeof Decision.Type

/**
 * Schema for where a block stands: `"open"` while it takes an answer,
 * `"answered"` once the user used it, `"closed"` when it closed without an
 * answer (the user answered in words, or moved on).
 *
 * @category schemas
 * @since 0.1.0
 */
export const BlockStatus = Schema.Literals(["open", "answered", "closed"])

/**
 * Where a block stands.
 *
 * @category models
 * @since 0.1.0
 */
export type BlockStatus = typeof BlockStatus.Type

/**
 * Schema for a block on an assistant's message: its kind and props (in JSON,
 * as the block's props schema encodes them), where it stands, the user's
 * answer (in JSON, as its answer schema encodes it), and, for a decision
 * block, its decisions.
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
 * A block on an assistant's message.
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
  at: Schema.Finite
})

/**
 * A message the user sent.
 *
 * @category models
 * @since 0.1.0
 */
export type UserMessage = typeof UserMessage.Type

/**
 * Schema for a message the assistant sent the user, with its block, if it
 * has one.
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
 * A message the assistant sent the user.
 *
 * @category models
 * @since 0.1.0
 */
export type AssistantMessage = typeof AssistantMessage.Type

/**
 * Schema for a message in the chat: the user's or the assistant's.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Message = Schema.Union([UserMessage, AssistantMessage])

/**
 * A message in the chat.
 *
 * @category models
 * @since 0.1.0
 */
export type Message = typeof Message.Type

/**
 * Schema for a specialist that works for the assistant: which one, and
 * since when (epoch milliseconds).
 *
 * @category schemas
 * @since 0.1.0
 */
export const SpecialistWorking = Schema.Struct({
  specialist: Schema.String,
  since: Schema.Finite
})

/**
 * A specialist that works for the assistant.
 *
 * @category models
 * @since 0.1.0
 */
export type SpecialistWorking = typeof SpecialistWorking.Type

/**
 * Schema for the message the assistant is writing to the user: its text so
 * far, which grows until the message arrives.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Composing = Schema.Struct({
  text: Schema.String
})

/**
 * The message the assistant is writing to the user.
 *
 * @category models
 * @since 0.1.0
 */
export type Composing = typeof Composing.Type

/**
 * Schema for what works in the chat: the assistant (a turn, or one about to
 * start, for something that arrived), and its specialists. Nothing works
 * when the chat is idle, even if a workflow waits on a timer or a decision.
 * `composing` is the message the assistant is writing to the user, while it
 * writes it: it goes when the message arrives in `messages`, or when the
 * assistant stops writing it without sending it. Only a live view has it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Activity = Schema.Struct({
  working: Schema.Boolean,
  specialists: Schema.Array(SpecialistWorking),
  composing: Schema.optional(Composing)
})

/**
 * What works in the chat.
 *
 * @category models
 * @since 0.1.0
 */
export type Activity = typeof Activity.Type

/**
 * Schema for a chat as its user sees it: its messages, what works in it,
 * and whether the last turn failed. `seq` is how far into the chat's log it
 * is.
 *
 * @category schemas
 * @since 0.1.0
 */
export const View = Schema.Struct({
  seq: Schema.Int,
  messages: Schema.Array(Message),
  activity: Activity,
  /** The last turn failed, and no message came after. */
  failed: Schema.Boolean
})

/**
 * A chat as its user sees it.
 *
 * @category models
 * @since 0.1.0
 */
export type View = typeof View.Type

/**
 * Schema for a change to a chat's view: the messages that are new or
 * changed (a block answered or closed, a decision decided), whole, and what
 * works in the chat and whether the last turn failed, now. `seq` is how far
 * into the log it is.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Update = Schema.Struct({
  seq: Schema.Int,
  messages: Schema.Array(Message),
  activity: Activity,
  failed: Schema.Boolean
})

/**
 * A change to a chat's view.
 *
 * @category models
 * @since 0.1.0
 */
export type Update = typeof Update.Type

/**
 * A chat before anything happened in it: no messages, and nothing working.
 *
 * @category constructors
 * @since 0.1.0
 */
export const empty: View = { seq: 0, messages: [], activity: { working: false, specialists: [] }, failed: false }

/**
 * Returns the view after an update: its messages replace the ones with
 * their ids, in place, and the new ones go after the rest.
 *
 * @category folding
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
    failed: update.failed
  }
}

/**
 * Returns whether nothing works in the chat: no turn, and no specialist.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isIdle = (view: View): boolean => !view.activity.working && view.activity.specialists.length === 0

/**
 * Options for a view of a chat's log.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The tags of the app's events that wake a turn: a turn is about to start after one. Default: none. */
  readonly wakes?: ReadonlySet<string> | undefined
}

/**
 * Returns a chat's view from its log's entries, for server-side code: a
 * client gets it from `MyAssistant.subscribeView`, which knows the
 * assistant's events.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, options?: Options): View => {
  const fold = folding(options?.wakes ?? new Set())

  for (const entry of entries) fold.step(entry)

  return fold.view
}

/** A fold over one chat's log, one entry at a time, and what the assistant composes in between. */
interface Folding {
  /** Folds one more entry, or what the assistant composes, and returns what changed for the user, if anything did. */
  readonly step: (entry: AssistantEvent.AnyEntry | AssistantEvent.Composing) => Update | undefined
  /** The whole view so far. */
  readonly view: View
}

const decodeProps = Schema.decodeUnknownOption(Decisions.Props)

const decodeAnswer = Schema.decodeUnknownOption(Decisions.Answer)

const activityOf = (activity: AssistantActivity.Activity, composing: string | undefined): Activity => {
  const working = {
    working: activity.turnSince !== undefined || activity.queued,
    specialists: [...activity.specialists.values()].map((run) => ({ specialist: run.specialist, since: run.since }))
  }

  return composing === undefined ? working : { ...working, composing: { text: composing } }
}

const sameActivity = (a: Activity, b: Activity) =>
  a.working === b.working &&
  a.composing?.text === b.composing?.text &&
  a.specialists.length === b.specialists.length &&
  a.specialists.every(
    (run, i) => run.specialist === b.specialists[i]?.specialist && run.since === b.specialists[i]?.since
  )

/** The decisions a decision block asks for. */
const decisionIds = (block: AssistantEvent.MessageBlock): ReadonlyArray<string> =>
  block.kind === Decisions.kind
    ? Option.match(decodeProps(block.props), { onNone: () => [], onSome: (props) => props.decisionIds })
    : []

/** Starts a fold over a chat's log. `wakes` are the tags of the app's events that wake a turn. */
const folding = (wakes: ReadonlySet<string>): Folding => {
  let seq = 0
  let failed = false
  let activity = AssistantActivity.empty
  // The message the assistant is writing: live only, and gone once a message arrives or the turn ends.
  let composing: string | undefined
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

      return decision === undefined
        ? []
        : [
            decision.outcome === undefined
              ? { id: decision.request.id, preview: decision.request.preview }
              : { id: decision.request.id, preview: decision.request.preview, outcome: decision.outcome }
          ]
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

  /** The messages an event changes for the user, by id. */
  const touched = (event: AssistantEvent.AssistantEvent, at: number): ReadonlyArray<string> =>
    Match.value(event).pipe(
      Match.tagsExhaustive({
        UserMessage: (message) => {
          messages.set(message.id, UserMessage.make({ id: message.id, text: message.text, at }))
          failed = false

          return [message.id]
        },
        AssistantMessage: (message) => {
          sent.set(message.id, message)
          composing = undefined
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
          composing = undefined

          return []
        },
        ModelOutput: () => [],
        ToolStarted: () => [],
        ToolResult: () => [],
        TurnStarted: () => [],
        TurnCompleted: () => {
          composing = undefined

          return []
        },
        SpecialistStarted: () => [],
        SpecialistFinished: () => [],
        DecisionRequested: () => []
      })
    )

  const step = (entry: AssistantEvent.AnyEntry | AssistantEvent.Composing): Update | undefined => {
    const before = { activity: activityOf(activity, composing), failed }

    if (Predicate.isTagged(entry, "Composing")) {
      composing = entry.text

      const now = activityOf(activity, composing)

      return sameActivity(before.activity, now) ? undefined : { seq, messages: [], activity: now, failed }
    }

    const { event } = entry

    seq = entry.seq
    activity = AssistantActivity.apply(activity, entry, { wakes })

    if (!AssistantEvent.isLibraryEvent(event)) {
      const now = activityOf(activity, composing)

      return sameActivity(before.activity, now) ? undefined : { seq, messages: [], activity: now, failed }
    }

    blocks = BlockKit.nextBlockStates(blocks, event)
    decisions = Decisions.nextStates(decisions, event)

    const changed = [...new Set(touched(event, entry.at))].flatMap((id) => {
      const message = sent.get(id)
      const current = messages.get(id)

      if (message === undefined || current === undefined) return current === undefined ? [] : [current]

      const next = viewOf(message, current.at)
      messages.set(id, next)

      return [next]
    })

    const now = activityOf(activity, composing)

    return changed.length === 0 && failed === before.failed && sameActivity(before.activity, now)
      ? undefined
      : { seq, messages: changed, activity: now, failed }
  }

  return {
    step,
    get view() {
      return { seq, messages: [...messages.values()], activity: activityOf(activity, composing), failed }
    }
  }
}

/** One update for several: their messages, each as it is in the last one that has it, and the last one's activity. */
const merge = (updates: ReadonlyArray<Update>): Update | undefined => {
  const last = updates.at(-1)

  if (last === undefined) return undefined

  const messages = new Map<string, Message>()

  for (const update of updates) for (const message of update.messages) messages.set(message.id, message)

  return { seq: last.seq, messages: [...messages.values()], activity: last.activity, failed: last.failed }
}

/**
 * Returns the updates a chat's entries make, streamed from the start of its
 * log: the ones after `after`, each chunk of entries (like the stored ones,
 * which come at once) as one update. What the assistant composes, in
 * between, is in `activity.composing`. `MyAssistant.subscribeView` is this
 * over the assistant's engine, which streams both.
 *
 * @category combinators
 * @since 0.1.0
 */
export const updates = <E, R>(
  entries: Stream.Stream<AssistantEvent.AnyEntry | AssistantEvent.Composing, E, R>,
  options?: Options & { readonly after?: number | undefined }
): Stream.Stream<Update, E, R> => {
  const after = options?.after ?? 0

  return entries.pipe(
    Stream.mapAccumArray(
      () => folding(options?.wakes ?? new Set()),
      (fold, chunk) => {
        const changed = chunk.flatMap((entry) => {
          const update = fold.step(entry)

          return update === undefined || (!Predicate.isTagged(entry, "Composing") && entry.seq <= after) ? [] : [update]
        })

        const merged = merge(changed)

        return [fold, merged === undefined ? [] : [merged]]
      }
    )
  )
}
