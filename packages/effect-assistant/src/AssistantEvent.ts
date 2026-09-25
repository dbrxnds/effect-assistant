/**
 * The `AssistantEvent` module defines everything that can happen in a chat. A chat
 * is an append-only log of these events, and the log is the source of truth:
 * the chat UI renders it, and the model's history is rebuilt from it before
 * every model call.
 *
 * - Inputs: {@link UserMessage}, {@link BlockAnswer}, {@link Fact}. Submitting
 *   one starts a turn, or joins the turn that is running.
 * - What the user sees: {@link AssistantMessage}, optionally with a
 *   {@link MessageBlock}.
 * - What the model did: {@link ModelOutput}, then {@link ToolStarted} and
 *   {@link ToolResult} for each tool call.
 * - Turn bookkeeping: {@link TurnStarted}, {@link TurnCompleted},
 *   {@link TurnFailed}.
 * - Specialist runs: {@link SpecialistStarted}, {@link SpecialistFinished}. A
 *   finished run is an input too: its report wakes a turn.
 * - Blocks closed without an answer: {@link BlocksClosed}.
 * - The app's own events, like a summary for compaction: {@link Custom}. An
 *   assistant's `events` option decodes them to their own types.
 *
 * Turns and specialist runs are the chat's activity: each opens with one event
 * and closes with another (see `AssistantActivity`).
 *
 * @since 0.1.0
 */
// The history items' declarations name effect-uai's `ImageSource`: importing its module lets ours name it too.
import type {} from "@effect-uai/core/Image"
import * as Items from "@effect-uai/core/Items"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { ChatId } from "./ChatId.ts"
import { InputId } from "./InputId.ts"
import * as InternalSchema from "./internal/schema.ts"
import { RunId } from "./RunId.ts"

/**
 * Text the user typed.
 *
 * @category inputs
 * @since 0.1.0
 */
export class UserMessage extends Schema.TaggedClass<UserMessage>()("UserMessage", {
  id: InputId,
  text: Schema.String
}) {}

/**
 * The user used a block: which message it was on, and the value in the
 * block's answer schema (its JSON form). A chat UI shows it inside the block
 * rather than as a message.
 *
 * @category inputs
 * @since 0.1.0
 */
export class BlockAnswer extends Schema.TaggedClass<BlockAnswer>()("BlockAnswer", {
  id: InputId,
  messageId: Schema.String,
  kind: Schema.String,
  value: Schema.Unknown
}) {}

/**
 * Something the assistant should know about that the user didn't type: a workflow
 * update, a finished specialist, a webhook. `source` names the sender, such
 * as `workflow:CreateCampaign`.
 *
 * **Details**
 *
 * The user doesn't see facts. The assistant decides whether to tell them, so a fact
 * can say what it needs ("get the user's approval") and let the assistant write the
 * message.
 *
 * @category inputs
 * @since 0.1.0
 */
export class Fact extends Schema.TaggedClass<Fact>()("Fact", {
  id: InputId,
  source: Schema.String,
  payload: Schema.Unknown
}) {}

/**
 * A specialist run finished working on a brief. Unless the assistant stopped
 * it, it's an input: a turn reads its report and decides what to tell the
 * user. Its id is fixed per run and brief, so it's stored once.
 *
 * - `answered`: `report` is its answer.
 * - `failed`: `error` says why.
 * - `stopped`: the assistant stopped it; no turn starts for it.
 * - `cut_off`: a shutdown interrupted it; spawn it again if it's still needed.
 *
 * @category specialists
 * @since 0.1.0
 */
export class SpecialistFinished extends Schema.TaggedClass<SpecialistFinished>()("SpecialistFinished", {
  id: InputId,
  runId: RunId,
  specialist: Schema.String,
  /** Which brief this answers: 1 for the first, then one more per follow-up. */
  brief: Schema.Int,
  goal: Schema.String,
  status: Schema.Literals(["answered", "failed", "stopped", "cut_off"]),
  report: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String)
}) {}

/**
 * Schema for everything `Assistant.submit` accepts.
 *
 * @category inputs
 * @since 0.1.0
 */
export const Input = Schema.Union([UserMessage, BlockAnswer, Fact, SpecialistFinished])

/**
 * An input to an assistant.
 *
 * @category inputs
 * @since 0.1.0
 */
export type Input = typeof Input.Type

/**
 * Schema for what a chat client may submit: user messages and block answers,
 * but not facts.
 *
 * @category inputs
 * @since 0.1.0
 */
export const ClientInput = Schema.Union([UserMessage, BlockAnswer])

/**
 * An input a chat client may submit.
 *
 * @category inputs
 * @since 0.1.0
 */
export type ClientInput = typeof ClientInput.Type

/**
 * The UI shown with a message: a block kind from the assistant's `BlockKit`, and
 * its props.
 *
 * @category models
 * @since 0.1.0
 */
export class MessageBlock extends Schema.Class<MessageBlock>("effect-assistant/MessageBlock")({
  kind: Schema.String,
  props: Schema.Unknown
}) {}

/**
 * A message the assistant sent the user with `send_user_message`, optionally with a
 * block.
 *
 * @category models
 * @since 0.1.0
 */
export class AssistantMessage extends Schema.TaggedClass<AssistantMessage>()("AssistantMessage", {
  id: Schema.String,
  text: Schema.String,
  block: Schema.optional(MessageBlock),
  /** Earlier messages whose block the user answered by typing instead; their blocks close. */
  closes: Schema.optional(Schema.Array(Schema.String))
}) {}

// effect-uai's `HistoryItem` schema declares `unknown` services for its content
// blocks, but the items are plain JSON. Dropping them keeps events JSON- and
// RPC-encodable.
const HistoryItems = InternalSchema.withoutServices(Schema.Array(Items.HistoryItem))

/**
 * The items of one model call: text, and tool calls.
 *
 * @category models
 * @since 0.1.0
 */
export class ModelOutput extends Schema.TaggedClass<ModelOutput>()("ModelOutput", {
  items: HistoryItems,
  /**
   * The last entry the model had read when it wrote this. Inputs after it
   * arrived while the model was working.
   */
  seenThroughSeq: Schema.optional(Schema.Int)
}) {}

/**
 * A tool call is about to run. It's stored before the tool runs, so after a
 * crash the log says which calls may have done something: they run again,
 * with the same call id (see `AssistantToolCall`).
 *
 * @category models
 * @since 0.1.0
 */
export class ToolStarted extends Schema.TaggedClass<ToolStarted>()("ToolStarted", {
  callId: Schema.String,
  tool: Schema.String
}) {}

/**
 * The output of one tool call, as the model sees it.
 *
 * @category models
 * @since 0.1.0
 */
export class ToolResult extends Schema.TaggedClass<ToolResult>()("ToolResult", {
  callId: Schema.String,
  tool: Schema.String,
  output: Schema.String
}) {}

/**
 * A turn started.
 *
 * @category turns
 * @since 0.1.0
 */
export class TurnStarted extends Schema.TaggedClass<TurnStarted>()("TurnStarted", {
  /** The assistant that runs it. Unset in logs from before it was recorded. */
  assistant: Schema.optional(Schema.String)
}) {}

/**
 * A turn finished. `throughSeq` is the last entry it read; inputs after it
 * still need a turn.
 *
 * @category turns
 * @since 0.1.0
 */
export class TurnCompleted extends Schema.TaggedClass<TurnCompleted>()("TurnCompleted", {
  throughSeq: Schema.Int
}) {}

/**
 * A turn failed. `throughSeq` covers everything stored when it failed, so a
 * failing input isn't retried forever.
 *
 * @category turns
 * @since 0.1.0
 */
export class TurnFailed extends Schema.TaggedClass<TurnFailed>()("TurnFailed", {
  throughSeq: Schema.Int,
  message: Schema.String
}) {}

/**
 * A specialist run started working: spawned, or continued by a follow-up
 * message. The model doesn't see it; it sees the run in "Running now", and
 * its report arrives as a {@link SpecialistFinished}.
 *
 * @category specialists
 * @since 0.1.0
 */
export class SpecialistStarted extends Schema.TaggedClass<SpecialistStarted>()("SpecialistStarted", {
  runId: RunId,
  specialist: Schema.String,
  /** The goal it's working on. Unset in logs from before it was recorded. */
  goal: Schema.optional(Schema.String)
}) {}

/**
 * Blocks closed without an answer, like the ones `turn.loop`'s
 * `BlockKit.closeStale` closes once the user moved on. The model doesn't see it.
 *
 * @category models
 * @since 0.1.0
 */
export class BlocksClosed extends Schema.TaggedClass<BlocksClosed>()("BlocksClosed", {
  messageIds: Schema.Array(Schema.String)
}) {}

/**
 * An event of the app's own, stored as its name and its encoded value. An
 * assistant made with `events: [Summary]` writes a `Summary` this way with
 * `turn.append`, and reads it back as a `Summary` from `turn.entries`. The
 * model doesn't see it unless a handler puts it in the history.
 *
 * @category models
 * @since 0.1.0
 */
export class Custom extends Schema.TaggedClass<Custom>()("Custom", {
  /** The event's `_tag`. */
  name: Schema.String,
  /** The event, in its schema's encoded form. */
  value: Schema.Unknown
}) {}

/**
 * Schema for every event in a chat.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AssistantEvent = Schema.Union([
  UserMessage,
  BlockAnswer,
  Fact,
  AssistantMessage,
  ModelOutput,
  ToolStarted,
  ToolResult,
  TurnStarted,
  TurnCompleted,
  TurnFailed,
  SpecialistStarted,
  SpecialistFinished,
  BlocksClosed,
  Custom
])

/**
 * An event in a chat.
 *
 * @category models
 * @since 0.1.0
 */
export type AssistantEvent = typeof AssistantEvent.Type

/**
 * A stored event with its position in the chat. `seq` starts at 1 and has no
 * gaps; `at` is the time it was stored, in epoch milliseconds.
 *
 * @category models
 * @since 0.1.0
 */
export class Entry extends Schema.Class<Entry>("effect-assistant/AssistantEvent/Entry")({
  chatId: ChatId,
  seq: Schema.Int,
  at: Schema.Finite,
  event: AssistantEvent
}) {}

/**
 * Returns whether an event is an input: a user message, a block answer, a
 * fact, or a finished specialist run.
 *
 * @category guards
 * @since 0.1.0
 */
export const isInput = (event: AssistantEvent): event is Input =>
  Predicate.isTagged(event, "UserMessage") ||
  Predicate.isTagged(event, "BlockAnswer") ||
  Predicate.isTagged(event, "Fact") ||
  Predicate.isTagged(event, "SpecialistFinished")

/**
 * Returns whether an input starts a turn: every one but a run the assistant
 * stopped itself.
 *
 * @category guards
 * @since 0.1.0
 */
export const wakes = (input: Input): boolean =>
  !(Predicate.isTagged(input, "SpecialistFinished") && input.status === "stopped")

/**
 * Returns whether an input came from the chat client (not a host fact).
 *
 * @category guards
 * @since 0.1.0
 */
export const isClientInput = (input: Input): input is ClientInput =>
  Predicate.isTagged(input, "UserMessage") || Predicate.isTagged(input, "BlockAnswer")

/**
 * Returns whether an event ends a turn, and so says how far the assistant has read.
 *
 * @category guards
 * @since 0.1.0
 */
export const isTurnEnd = (event: AssistantEvent): event is TurnCompleted | TurnFailed =>
  Predicate.isTagged(event, "TurnCompleted") || Predicate.isTagged(event, "TurnFailed")

/**
 * Returns the text of every message the user was shown, in order.
 *
 * @category getters
 * @since 0.1.0
 */
export const assistantTexts = (entries: ReadonlyArray<Entry>): ReadonlyArray<string> =>
  entries.flatMap(({ event }) => (Predicate.isTagged(event, "AssistantMessage") ? [event.text] : []))
