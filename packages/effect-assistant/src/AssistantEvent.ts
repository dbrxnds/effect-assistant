/**
 * The `AssistantEvent` module defines everything that can happen in a chat. A chat
 * is an append-only log of these events, and the log is the source of truth:
 * a chat client gets what its user sees of it (`ChatView`), and the model's
 * history is rebuilt from it before every model call.
 */
import * as Response from "effect/ai/Response"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { ChatId } from "./ChatId.ts"
import { DecisionId } from "./DecisionId.ts"
import { InputId } from "./InputId.ts"
import { RunId } from "./RunId.ts"

/**
 * A file the user attached to a message, by reference: the file itself is
 * stored elsewhere, so the log never holds its bytes.
 */
export const Attachment = Schema.Struct({
  fileId: Schema.String.check(Schema.isMaxLength(64)),
  name: Schema.String.check(Schema.isMaxLength(255)),
  mediaType: Schema.String.check(Schema.isMaxLength(127)),
  /** In bytes. */
  size: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
})

/** The most files one message carries: each is a line in every prompt after it. */
export const MAX_ATTACHMENTS = 10

/** A file the user attached to a message. */
export type Attachment = typeof Attachment.Type

/** A byte count for people and the model: `2.1 MB`. */
export const formatSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1024 * 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`

/** The line the model reads for an attachment. It names the file and never holds its content. */
export const attachmentLine = (attachment: Attachment): string =>
  `[attached: ${attachment.name}, ${attachment.mediaType}, ${formatSize(attachment.size)}, id ${attachment.fileId}]`

/** The text of a message followed by a line per attached file. */
export const textWithAttachments = (text: string, attachments: ReadonlyArray<Attachment> | undefined): string =>
  attachments === undefined || attachments.length === 0
    ? text
    : [text, ...attachments.map(attachmentLine)].filter((part) => part.length > 0).join("\n")

/** Text the user typed, and the files they attached. */
export class UserMessage extends Schema.TaggedClass<UserMessage>()("UserMessage", {
  id: InputId,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(Attachment).check(Schema.isMaxLength(MAX_ATTACHMENTS)))
}) {}

/**
 * The user used a block: which message it was on, and the value in the
 * block's answer schema (its JSON form). A chat UI shows it inside the block
 * rather than as a message.
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

/** Schema for how the user decided: `"approved"` or `"declined"`. */
export const DecisionOutcome = Schema.Literals(["approved", "declined"])

/** How the user decided. */
export type DecisionOutcome = typeof DecisionOutcome.Type

/**
 * Schema for a decision a tool call waits for: the call, as the model wrote
 * it. Approving it runs exactly this call.
 */
export const CallOrigin = Schema.TaggedStruct("Call", {
  callId: Schema.String,
  tool: Schema.String,
  params: Schema.Json
})

/** A decision a tool call waits for. */
export type CallOrigin = typeof CallOrigin.Type

/** The user is asked to decide something: approve or decline. */
export class DecisionRequested extends Schema.TaggedClass<DecisionRequested>()("DecisionRequested", {
  id: DecisionId,
  origin: CallOrigin,
  preview: Schema.Json
}) {}

/**
 * A decision is made: the user answered a decision block for it (`answer` is
 * that `BlockAnswer`'s id). An approved call runs next, at the turn's next
 * step.
 */
export class DecisionResolved extends Schema.TaggedClass<DecisionResolved>()("DecisionResolved", {
  id: DecisionId,
  outcome: DecisionOutcome,
  answer: InputId
}) {}

/** Schema for everything `Assistant.submit` accepts. */
export const Input = Schema.Union([UserMessage, BlockAnswer, SpecialistFinished])

/** An input to an assistant. */
export type Input = typeof Input.Type

/**
 * Schema for the inputs from the chat's user: messages and block answers. A
 * turn owes each one a reply. It's also what a chat client usually may
 * submit; the app's events come from the server.
 */
export const UserInput = Schema.Union([UserMessage, BlockAnswer])

/** An input from the chat's user. */
export type UserInput = typeof UserInput.Type

/**
 * The UI shown with a message: a block kind from the assistant's `BlockKit`, and
 * its props.
 */
export class MessageBlock extends Schema.Class<MessageBlock>("effect-assistant/MessageBlock")({
  kind: Schema.String,
  props: Schema.Unknown
}) {}

/**
 * A message the assistant sent the user with `send_user_message`, optionally with a
 * block.
 */
export class AssistantMessage extends Schema.TaggedClass<AssistantMessage>()("AssistantMessage", {
  id: Schema.String,
  text: Schema.String,
  block: Schema.optional(MessageBlock),
  /** Earlier messages whose block the user answered by typing instead; their blocks close. */
  closes: Schema.optional(Schema.Array(Schema.String))
}) {}

/**
 * Schema for a tool call the model made: `effect/ai`'s tool call
 * part (`Response.ToolCallPart`) for any tool, with its params in JSON, as the
 * model wrote them.
 */
export const ToolCallPart = Schema.Struct({
  ...Response.ToolCallPart("", Schema.Json).fields,
  name: Schema.String
}).annotate({ identifier: "ToolCallPart" })

/** A tool call the model made. */
export type ToolCallPart = typeof ToolCallPart.Type

/**
 * Schema for what the log keeps of a model call: `effect/ai`'s
 * response parts for text, reasoning (with the provider's metadata, like a
 * thinking block's signature), and tool calls.
 */
export const ModelPart = Schema.Union([Response.TextPart, Response.ReasoningPart, ToolCallPart])

/** A part of a model call's output. */
export type ModelPart = typeof ModelPart.Type

/**
 * What one model call wrote: text, reasoning, and tool calls, as response
 * parts. `Prompt.fromResponseParts` turns them into history.
 */
export class ModelOutput extends Schema.TaggedClass<ModelOutput>()("ModelOutput", {
  parts: Schema.Array(ModelPart),
  /**
   * The last entry the model had read when it wrote this. Inputs after it
   * arrived while the model was working. A turn has handled what its
   * outputs had read.
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
 */
export class ToolStarted extends Schema.TaggedClass<ToolStarted>()("ToolStarted", {
  callId: Schema.String,
  tool: Schema.String
}) {}

/**
 * Schema for how a tool call went: `"success"`, or `"failure"`, which the
 * model reads as an error.
 */
export const ToolOutcome = Schema.Literals(["success", "failure"])

/** How a tool call went. */
export type ToolOutcome = typeof ToolOutcome.Type

/**
 * The result of one tool call, as the model reads it: the tool's success or
 * failure in its encoded (JSON) form, and which one it is. A failure says its
 * kind when it has one: a `ToolFailure`'s `kind`, or its tag.
 */
export class ToolResult extends Schema.TaggedClass<ToolResult>()("ToolResult", {
  callId: Schema.String,
  tool: Schema.String,
  outcome: ToolOutcome,
  result: Schema.Json,
  kind: Schema.optional(Schema.String)
}) {}

/** A turn started. */
export class TurnStarted extends Schema.TaggedClass<TurnStarted>()("TurnStarted", {
  /** The assistant that runs it. */
  assistant: Schema.String,
  /**
   * The id of the turn's trace, when a tracer records it (not Effect's own, which exports nothing).
   */
  traceId: Schema.optional(Schema.String)
}) {}

/**
 * A turn finished. `throughSeq` is the last entry it read; inputs after it
 * still need a turn.
 */
export class TurnCompleted extends Schema.TaggedClass<TurnCompleted>()("TurnCompleted", {
  throughSeq: Schema.Int
}) {}

/**
 * A turn failed. `throughSeq` covers everything stored when it failed, so a
 * failing input isn't retried forever.
 */
export class TurnFailed extends Schema.TaggedClass<TurnFailed>()("TurnFailed", {
  throughSeq: Schema.Int,
  message: Schema.String
}) {}

/**
 * A specialist run started working: spawned, or continued by a follow-up
 * message. The model doesn't see it: the call that started the run says
 * so, and its report arrives as a {@link SpecialistFinished}.
 */
export class SpecialistStarted extends Schema.TaggedClass<SpecialistStarted>()("SpecialistStarted", {
  runId: RunId,
  specialist: Schema.String,
  /** The goal it's working on. */
  goal: Schema.String
}) {}

/**
 * The chat was deleted: it stores nothing after this, what worked in it
 * stopped, and its subscribers' streams end here. Its log stays.
 */
export class ChatDeleted extends Schema.TaggedClass<ChatDeleted>()("ChatDeleted", {}) {}

/**
 * Blocks closed without an answer, like the ones `turn.loop`'s
 * `BlockKit.closeStale` closes once the user moved on. The model doesn't see it.
 */
export class BlocksClosed extends Schema.TaggedClass<BlocksClosed>()("BlocksClosed", {
  messageIds: Schema.Array(Schema.String)
}) {}

/** Schema for every event the library defines. */
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
  DecisionResolved,
  ChatDeleted
])

/** An event the library defines. */
export type AssistantEvent = typeof AssistantEvent.Type

const libraryTags: ReadonlySet<string> = new Set(AssistantEvent.members.map((member) => member.identifier))

/**
 * Schema for the tag of one of the app's own events: any tag but the
 * library's, branded, so narrowing an entry's event to one of the library's
 * events (`Predicate.isTagged(event, "UserMessage")`) never leaves an app
 * event in.
 */
export const AppTag = Schema.String.pipe(Schema.brand("effect-assistant/AppTag"))

/**
 * Schema for one of the app's own events, as it's stored: its `_tag` and its
 * fields in JSON. An assistant made with `events: [AppEvent.make(Summary)]`
 * decodes it to a `Summary` in `turn.entries` and in its `subscribe`.
 */
export const StoredAppEvent = Schema.StructWithRest(Schema.Struct({ _tag: AppTag }), [
  Schema.Record(Schema.String, Schema.Json)
]).check(Schema.makeFilter((event) => !libraryTags.has(event._tag) || `${event._tag} is one of the library's events`))

/** One of the app's own events, as it's stored. */
export type StoredAppEvent = typeof StoredAppEvent.Type

/** Returns whether an event is one of the library's, not one of the app's own. */
export const isLibraryEvent = (event: { readonly _tag: string }): event is AssistantEvent => libraryTags.has(event._tag)

/**
 * A chat's entry with any event in it: the library's, or the app's own
 * (decoded or not). What the folds over a chat take, so a client's typed
 * entries fit too.
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
 */
export const Entry = Schema.Struct({
  chatId: ChatId,
  seq: Schema.Int,
  at: Schema.Finite,
  event: Schema.Union([AssistantEvent, StoredAppEvent])
})

/** A stored event with its position in the chat. */
export type Entry = typeof Entry.Type

/**
 * Returns whether an event is one of the library's inputs: a user message,
 * a block answer, or a finished specialist run. The app's events that wake a turn are inputs too, but only
 * their assistant knows which (see `AppEvent`).
 */
export const isInput = (event: { readonly _tag: string }): event is Input =>
  Predicate.isTagged(event, "UserMessage") ||
  Predicate.isTagged(event, "BlockAnswer") ||
  Predicate.isTagged(event, "SpecialistFinished")

/**
 * Returns whether an input starts a turn: every one but a run the assistant
 * stopped itself.
 */
export const isWaking = (input: Input): boolean =>
  !(Predicate.isTagged(input, "SpecialistFinished") && input.status === "stopped")

/** Returns whether an input came from the chat's user, and so is owed a reply. */
export const isUserInput = (input: Input): input is UserInput =>
  Predicate.isTagged(input, "UserMessage") || Predicate.isTagged(input, "BlockAnswer")

/** Returns whether an event ends a turn, and so says how far the assistant has read. */
export const isTurnEnd = (event: { readonly _tag: string }): event is TurnCompleted | TurnFailed =>
  Predicate.isTagged(event, "TurnCompleted") || Predicate.isTagged(event, "TurnFailed")

/** Returns the text of every message the user was shown, in order. */
export const assistantTexts = (entries: ReadonlyArray<AnyEntry>): ReadonlyArray<string> =>
  entries.flatMap(({ event }) =>
    isLibraryEvent(event) && Predicate.isTagged(event, "AssistantMessage") ? [event.text] : []
  )
