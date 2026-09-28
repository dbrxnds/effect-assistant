/**
 * The `AssistantEvent` module defines everything that can happen in a chat. A chat
 * is an append-only log of these events, and the log is the source of truth:
 * a chat client gets what its user sees of it (`ChatView`), and the model's
 * history is rebuilt from it before every model call.
 *
 * - Inputs from the user: {@link UserMessage}, {@link BlockAnswer}. Submitting
 *   one starts a turn, or joins the turn that is running.
 * - What the user sees: {@link AssistantMessage}, optionally with a
 *   {@link MessageBlock}.
 * - What the model did: {@link ModelOutput}, then {@link ToolStarted} and
 *   {@link ToolResult} for each tool call. These are the assistant's own
 *   work: a chat client never gets them (see `ChatView`).
 * - Turn bookkeeping: {@link TurnStarted}, {@link TurnCompleted},
 *   {@link TurnFailed}.
 * - Specialist runs: {@link SpecialistStarted}, {@link SpecialistFinished}. A
 *   finished run is an input too: its report wakes a turn.
 * - Blocks closed without an answer: {@link BlocksClosed}.
 * - Decisions the user is asked to make: {@link DecisionRequested}, when a
 *   tool call waits for one or work asks for one (that one is an input), and
 *   {@link DecisionResolved}, once the user answered its decision block.
 * - The app's own events, like a workflow's progress or a summary for
 *   compaction: {@link StoredAppEvent}, as they're stored. The ones an
 *   assistant registers (see `AppEvent`) decode to their own types, and
 *   those registered with `wakes` start a turn.
 *
 * Turns and specialist runs are the chat's activity: each opens with one event
 * and closes with another (see `AssistantActivity`).
 *
 * @since 0.1.0
 */
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Response from "effect/unstable/ai/Response"
import { ChatId } from "./ChatId.ts"
import { DecisionId } from "./DecisionId.ts"
import { InputId } from "./InputId.ts"
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
 * Schema for how the user decided: `"approved"` or `"declined"`.
 *
 * @category decisions
 * @since 0.1.0
 */
export const DecisionOutcome = Schema.Literals(["approved", "declined"])

/**
 * How the user decided.
 *
 * @category decisions
 * @since 0.1.0
 */
export type DecisionOutcome = typeof DecisionOutcome.Type

/**
 * Schema for a decision a tool call waits for: the call, as the model wrote
 * it. Approving it runs exactly this call.
 *
 * @category decisions
 * @since 0.1.0
 */
export const CallOrigin = Schema.TaggedStruct("Call", {
  callId: Schema.String,
  tool: Schema.String,
  params: Schema.Json
})

/**
 * A decision a tool call waits for.
 *
 * @category decisions
 * @since 0.1.0
 */
export type CallOrigin = typeof CallOrigin.Type

/**
 * Schema for a decision that running work asks for, like a workflow: who
 * asks (`source`, like `workflow:CreateCampaign`), and, for a workflow waiting on it, the
 * `DurableDeferred` token the answer completes.
 *
 * @category decisions
 * @since 0.1.0
 */
export const WorkOrigin = Schema.TaggedStruct("Work", {
  source: Schema.String,
  token: Schema.optional(Schema.String)
})

/**
 * A decision that running work asks for.
 *
 * @category decisions
 * @since 0.1.0
 */
export type WorkOrigin = typeof WorkOrigin.Type

/**
 * The user is asked to decide something: approve or decline.
 *
 * - From a tool call (`origin: Call`): the model called a tool that needs
 *   the user's decision, and the loop parked the call instead of running it.
 *   The model reads this as the call's result. It's not an input.
 * - From work (`origin: Work`): something already running asks, like a
 *   workflow. It's an input: it wakes a turn.
 *
 * Either way the user sees nothing yet: the model sends a message with a
 * decision block for its id. `preview` is what they decide on, like an
 * order's total, in JSON.
 *
 * @category decisions
 * @since 0.1.0
 */
export class DecisionRequested extends Schema.TaggedClass<DecisionRequested>()("DecisionRequested", {
  id: DecisionId,
  origin: Schema.Union([CallOrigin, WorkOrigin]),
  preview: Schema.Json
}) {}

/**
 * A decision is made: the user answered a decision block for it (`answer` is
 * that `BlockAnswer`'s id). An approved call runs next, at the turn's next
 * step; a workflow's decision is passed on to it before this is stored.
 *
 * @category decisions
 * @since 0.1.0
 */
export class DecisionResolved extends Schema.TaggedClass<DecisionResolved>()("DecisionResolved", {
  id: DecisionId,
  outcome: DecisionOutcome,
  answer: InputId
}) {}

/**
 * Schema for everything `Assistant.submit` accepts. A `DecisionRequested` is
 * one only when work requests it (`origin: Work`); the chat refuses a parked
 * call submitted from outside.
 *
 * @category inputs
 * @since 0.1.0
 */
export const Input = Schema.Union([UserMessage, BlockAnswer, SpecialistFinished, DecisionRequested])

/**
 * An input to an assistant.
 *
 * @category inputs
 * @since 0.1.0
 */
export type Input = typeof Input.Type

/**
 * Schema for the inputs from the chat's user: messages and block answers. A
 * turn owes each one a reply. It's also what a chat client usually may
 * submit; the app's events come from the server.
 *
 * @category inputs
 * @since 0.1.0
 */
export const UserInput = Schema.Union([UserMessage, BlockAnswer])

/**
 * An input from the chat's user.
 *
 * @category inputs
 * @since 0.1.0
 */
export type UserInput = typeof UserInput.Type

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

/**
 * Schema for a tool call the model made: `effect/unstable/ai`'s tool call
 * part (`Response.ToolCallPart`) for any tool, with its params in JSON, as the
 * model wrote them.
 *
 * @category models
 * @since 0.1.0
 */
export const ToolCallPart = Schema.Struct({
  ...Response.ToolCallPart("", Schema.Json).fields,
  name: Schema.String
}).annotate({ identifier: "ToolCallPart" })

/**
 * A tool call the model made.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolCallPart = typeof ToolCallPart.Type

/**
 * Schema for what the log keeps of a model call: `effect/unstable/ai`'s
 * response parts for text, reasoning (with the provider's metadata, like a
 * thinking block's signature), and tool calls.
 *
 * @category models
 * @since 0.1.0
 */
export const ModelPart = Schema.Union([Response.TextPart, Response.ReasoningPart, ToolCallPart])

/**
 * A part of a model call's output.
 *
 * @category models
 * @since 0.1.0
 */
export type ModelPart = typeof ModelPart.Type

/**
 * What one model call wrote: text, reasoning, and tool calls, as response
 * parts. `Prompt.fromResponseParts` turns them into history.
 *
 * @category models
 * @since 0.1.0
 */
export class ModelOutput extends Schema.TaggedClass<ModelOutput>()("ModelOutput", {
  parts: Schema.Array(ModelPart),
  /**
   * The last entry the model had read when it wrote this. Inputs after it
   * arrived while the model was working.
   */
  seenThroughSeq: Schema.optional(Schema.Int),
  /** The model that wrote it: the provider's id for it, or the name the context gave it. */
  model: Schema.optional(Schema.String),
  /** The provider's id for the response, when it gives one. */
  responseId: Schema.optional(Schema.String),
  /** The call's tokens: input (with the cache's reads and writes) and output. */
  usage: Schema.optional(Response.Usage),
  /** How long the call took, in milliseconds. */
  durationMillis: Schema.optional(Schema.Finite)
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
 * Schema for how a tool call went: `"success"`, or `"failure"`, which the
 * model reads as an error.
 *
 * @category models
 * @since 0.1.0
 */
export const ToolOutcome = Schema.Literals(["success", "failure"])

/**
 * How a tool call went.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolOutcome = typeof ToolOutcome.Type

/**
 * The result of one tool call, as the model reads it: the tool's success or
 * failure in its encoded (JSON) form, and which one it is. A failure says its
 * kind when it has one: a `ToolFailure`'s `kind`, or its tag.
 *
 * @category models
 * @since 0.1.0
 */
export class ToolResult extends Schema.TaggedClass<ToolResult>()("ToolResult", {
  callId: Schema.String,
  tool: Schema.String,
  outcome: ToolOutcome,
  result: Schema.Json,
  kind: Schema.optional(Schema.String)
}) {}

/**
 * A turn started.
 *
 * @category turns
 * @since 0.1.0
 */
export class TurnStarted extends Schema.TaggedClass<TurnStarted>()("TurnStarted", {
  /** The assistant that runs it. */
  assistant: Schema.String,
  /** The id of the turn's trace, when a tracer records it (not Effect's own, which exports nothing). */
  traceId: Schema.optional(Schema.String)
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
 * message. The model doesn't see it: the call that started the run says
 * so, and its report arrives as a {@link SpecialistFinished}.
 *
 * @category specialists
 * @since 0.1.0
 */
export class SpecialistStarted extends Schema.TaggedClass<SpecialistStarted>()("SpecialistStarted", {
  runId: RunId,
  specialist: Schema.String,
  /** The goal it's working on. */
  goal: Schema.String
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
 * Schema for every event the library defines.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AssistantEvent = Schema.Union([
  UserMessage,
  BlockAnswer,
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
  DecisionRequested,
  DecisionResolved
])

/**
 * An event the library defines.
 *
 * @category models
 * @since 0.1.0
 */
export type AssistantEvent = typeof AssistantEvent.Type

const libraryTags: ReadonlySet<string> = new Set(AssistantEvent.members.map((member) => member.identifier))

/**
 * Schema for the tag of one of the app's own events: any tag but the
 * library's, branded, so narrowing an entry's event to one of the library's
 * events (`Predicate.isTagged(event, "UserMessage")`) never leaves an app
 * event in.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AppTag = Schema.String.pipe(Schema.brand("effect-assistant/AppTag"))

/**
 * Schema for one of the app's own events, as it's stored: its `_tag` and its
 * fields in JSON. An assistant made with `events: [AppEvent.make(Summary)]`
 * decodes it to a `Summary` in `turn.entries` and in its `subscribe`.
 *
 * @category models
 * @since 0.1.0
 */
export const StoredAppEvent = Schema.StructWithRest(Schema.Struct({ _tag: AppTag }), [
  Schema.Record(Schema.String, Schema.Json)
]).check(Schema.makeFilter((event) => !libraryTags.has(event._tag) || `${event._tag} is one of the library's events`))

/**
 * One of the app's own events, as it's stored.
 *
 * @category models
 * @since 0.1.0
 */
export type StoredAppEvent = typeof StoredAppEvent.Type

/**
 * Returns whether an event is one of the library's, not one of the app's own.
 *
 * @category guards
 * @since 0.1.0
 */
export const isLibraryEvent = (event: { readonly _tag: string }): event is AssistantEvent => libraryTags.has(event._tag)

/**
 * A chat's entry with any event in it: the library's, or the app's own
 * (decoded or not). What the folds over a chat take, so a client's typed
 * entries fit too.
 *
 * @category models
 * @since 0.1.0
 */
export interface AnyEntry {
  readonly chatId: ChatId
  readonly seq: number
  readonly at: number
  readonly event: { readonly _tag: string }
}

/**
 * Schema for a stored event with its position in the chat. `seq` starts at 1
 * and has no gaps; `at` is the time it was stored, in epoch milliseconds.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Entry = Schema.Struct({
  chatId: ChatId,
  seq: Schema.Int,
  at: Schema.Finite,
  event: Schema.Union([AssistantEvent, StoredAppEvent])
})

/**
 * A stored event with its position in the chat.
 *
 * @category models
 * @since 0.1.0
 */
export type Entry = typeof Entry.Type

/**
 * Returns whether an event is one of the library's inputs: a user message,
 * a block answer, a finished specialist run, or a decision that work
 * requests. The app's events that wake a turn are inputs too, but only
 * their assistant knows which (see `AppEvent`).
 *
 * @category guards
 * @since 0.1.0
 */
export const isInput = (event: { readonly _tag: string }): event is Input =>
  Predicate.isTagged(event, "UserMessage") ||
  Predicate.isTagged(event, "BlockAnswer") ||
  Predicate.isTagged(event, "SpecialistFinished") ||
  (Predicate.isTagged(event, "DecisionRequested") &&
    Predicate.hasProperty(event, "origin") &&
    Predicate.isTagged(event.origin, "Work"))

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
 * Returns whether an input came from the chat's user, and so is owed a reply.
 *
 * @category guards
 * @since 0.1.0
 */
export const isUserInput = (input: Input): input is UserInput =>
  Predicate.isTagged(input, "UserMessage") || Predicate.isTagged(input, "BlockAnswer")

/**
 * Returns whether an event ends a turn, and so says how far the assistant has read.
 *
 * @category guards
 * @since 0.1.0
 */
export const isTurnEnd = (event: { readonly _tag: string }): event is TurnCompleted | TurnFailed =>
  Predicate.isTagged(event, "TurnCompleted") || Predicate.isTagged(event, "TurnFailed")

/**
 * Returns the text of every message the user was shown, in order.
 *
 * @category getters
 * @since 0.1.0
 */
export const assistantTexts = (entries: ReadonlyArray<AnyEntry>): ReadonlyArray<string> =>
  entries.flatMap(({ event }) =>
    isLibraryEvent(event) && Predicate.isTagged(event, "AssistantMessage") ? [event.text] : []
  )
