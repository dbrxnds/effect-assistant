/**
 * The `ChatView` module is a chat as its user sees it: what a chat client
 * gets, and all it gets.
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
 * Schema for a decision as the user sees it on a decision block: the call
 * it's for (its tool and params, which the app shows as it likes), and how
 * they decided, once they did.
 */
export const Decision = Schema.Struct({
  id: DecisionId,
  tool: Schema.String,
  params: Schema.Json,
  outcome: Schema.optional(AssistantEvent.DecisionOutcome)
})

/** A decision as the user sees it. */
export type Decision = typeof Decision.Type

/**
 * Schema for where a block stands: `"open"` while it takes an answer,
 * `"answered"` once the user used it, `"closed"` when it closed without an
 * answer (the user answered in words, or moved on).
 */
export const BlockStatus = Schema.Literals(["open", "answered", "closed"])

/** Where a block stands. */
export type BlockStatus = typeof BlockStatus.Type

/**
 * Schema for a block on an assistant's message: its kind and props (in JSON,
 * as the block's props schema encodes them), where it stands, the user's
 * answer (in JSON, as its answer schema encodes it), and, for a decision
 * block, its decisions.
 */
export const Block = Schema.Struct({
  kind: Schema.String,
  props: Schema.Json,
  status: BlockStatus,
  answer: Schema.optional(Schema.Json),
  decisions: Schema.optional(Schema.Array(Decision))
})

/** A block on an assistant's message. */
export type Block = typeof Block.Type

/**
 * Schema for a message the user sent. `at` is when it was stored, in epoch
 * milliseconds.
 */
export const UserMessage = Schema.TaggedStruct("UserMessage", {
  id: InputId,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(AssistantEvent.Attachment)),
  at: Schema.Finite
})

/** A message the user sent. */
export type UserMessage = typeof UserMessage.Type

/**
 * Schema for a message the assistant sent the user, with its block, if it
 * has one.
 */
export const AssistantMessage = Schema.TaggedStruct("AssistantMessage", {
  id: Schema.String,
  text: Schema.String,
  at: Schema.Finite,
  block: Schema.optional(Block)
})

/** A message the assistant sent the user. */
export type AssistantMessage = typeof AssistantMessage.Type

/** Schema for a message in the chat: the user's or the assistant's. */
export const Message = Schema.Union([UserMessage, AssistantMessage])

/** A message in the chat. */
export type Message = typeof Message.Type

/**
 * Schema for a specialist that works for the assistant: which one, and
 * since when (epoch milliseconds).
 */
export const SpecialistWorking = Schema.Struct({
  specialist: Schema.String,
  since: Schema.Finite
})

/** A specialist that works for the assistant. */
export type SpecialistWorking = typeof SpecialistWorking.Type

/**
 * Schema for what works in the chat: the assistant (a turn, or one about to
 * start, for something that arrived), and its specialists. Nothing works
 * when the chat is idle, even if a workflow waits on a timer or a decision.
 */
export const Activity = Schema.Struct({
  working: Schema.Boolean,
  specialists: Schema.Array(SpecialistWorking)
})

/** What works in the chat. */
export type Activity = typeof Activity.Type

/**
 * Schema for a chat as its user sees it: its messages, what works in it,
 * whether the last turn failed, and whether the chat was deleted. `seq` is
 * how far into the chat's log it is.
 */
export const View = Schema.Struct({
  seq: Schema.Int,
  messages: Schema.Array(Message),
  activity: Activity,
  /** The last turn failed, and no message came after. */
  failed: Schema.Boolean,
  /** The chat was deleted: it takes nothing more, and its stream ends. */
  deleted: Schema.Boolean
})

/** A chat as its user sees it. */
export type View = typeof View.Type

/**
 * Schema for a change to a chat's view: the messages that are new or
 * changed (a block answered or closed, a decision decided), whole, and what
 * works in the chat, whether the last turn failed, and whether the chat was
 * deleted, now. `seq` is how far into the log it is.
 */
export const Update = Schema.Struct({
  seq: Schema.Int,
  messages: Schema.Array(Message),
  activity: Activity,
  failed: Schema.Boolean,
  deleted: Schema.Boolean
})

/** A change to a chat's view. */
export type Update = typeof Update.Type

/** A chat before anything happened in it: no messages, and nothing working. */
export const empty: View = {
  seq: 0,
  messages: [],
  activity: { working: false, specialists: [] },
  failed: false,
  deleted: false
}

/**
 * Returns the view after an update: its messages replace the ones with
 * their ids, in place, and the new ones go after the rest.
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

/** Returns whether nothing works in the chat: no turn, and no specialist. */
export const isIdle = (view: View): boolean => !view.activity.working && view.activity.specialists.length === 0

/** Options for a view of a chat's log. */
export interface Options {
  /**
   * The tags of the app's events that wake a turn: a turn is about to start after one. Default: none.
   */
  readonly wakes?: ReadonlySet<string> | undefined
}

/**
 * Returns a chat's view from its log's entries, for server-side code: a
 * client gets it from `MyAssistant.subscribeView`, which knows the
 * assistant's events.
 */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, options?: Options): View => {
  const fold = folding(options?.wakes ?? new Set())

  for (const entry of entries) fold.step(entry)

  return fold.view
}

/** A fold over one chat's log, one entry at a time. */
interface Folding {
  /** Folds one more entry, and returns what changed for the user, if anything did. */
  readonly step: (entry: AssistantEvent.AnyEntry) => Update | undefined
  /** The whole view so far. */
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

/** The decisions a decision block asks for. */
const decisionIds = (block: AssistantEvent.MessageBlock): ReadonlyArray<string> =>
  block.kind === Decisions.kind
    ? Option.match(decodeProps(block.props), {
        onNone: () => [],
        onSome: (props) => props.decisionIds
      })
    : []

/** Starts a fold over a chat's log. `wakes` are the tags of the app's events that wake a turn. */
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

  /** The messages an event changes for the user, by id. */
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

/**
 * One update for several: their messages, each as it is in the last one that has it, and the last one's activity.
 */
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
 * Returns the updates a chat's entries make, streamed from the start of its
 * log (as `MyAssistant.subscribe` streams them): the ones after `after`, each
 * chunk of entries (like the stored ones, which come at once) as one update.
 * `MyAssistant.subscribeView` is this over the assistant's log.
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
