/**
 * Defines the events that can happen in a chat.
 *
 * A chat is an append-only log of these events, and the log is the source of truth. A chat client
 * receives the part of the log its user sees (`ChatView`), and the model's history is rebuilt
 * from the log before every model call. Besides the library's events ({@link AssistantEvent}), a
 * log holds the application's own events ({@link StoredAppEvent}).
 *
 * @since 0.1.0
 */
import * as Response from "effect/ai/Response"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { ChatId } from "./ChatId.ts"
import { InputId, make as makeInputId } from "./InputId.ts"
import { RunId } from "./RunId.ts"

/**
 * Schema for a file the user attached to a message, kept by reference.
 *
 * The file itself is stored elsewhere, so the log never holds its bytes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attachment = Schema.Struct({
  fileId: Schema.String.check(Schema.isMaxLength(64)),
  name: Schema.String.check(Schema.isMaxLength(255)),
  mediaType: Schema.String.check(Schema.isMaxLength(127)),
  /** In bytes. */
  size: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
})

/**
 * The maximum number of files one message can carry.
 *
 * Each attached file is a line in every prompt after the message.
 *
 * @category utils
 * @since 0.1.0
 */
export const maxAttachments = 10

/**
 * Represents a file the user attached to a message.
 *
 * @category models
 * @since 0.1.0
 */
export type Attachment = typeof Attachment.Type

/**
 * Formats a byte count for people and the model, such as `2.1 MB`.
 *
 * @category utils
 * @since 0.1.0
 */
export const formatSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1024 * 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`

/**
 * Returns the line the model reads for an attachment.
 *
 * The line names the file and never holds its content.
 *
 * @category utils
 * @since 0.1.0
 */
export const attachmentLine = (attachment: Attachment): string =>
  `[attached: ${attachment.name}, ${attachment.mediaType}, ${formatSize(attachment.size)}, id ${attachment.fileId}]`

/**
 * Returns a message's text followed by a line for each attached file.
 *
 * @category utils
 * @since 0.1.0
 */
export const textWithAttachments = (text: string, attachments: ReadonlyArray<Attachment> | undefined): string =>
  attachments === undefined || attachments.length === 0
    ? text
    : [text, ...attachments.map(attachmentLine)].filter((part) => part.length > 0).join("\n")

/**
 * Represents text the user typed, and the files they attached.
 *
 * `id` defaults to a new one. Pass the client's own id so that a retried send stores the message
 * once.
 *
 * @category schemas
 * @since 0.1.0
 */
export class UserMessage extends Schema.TaggedClass<UserMessage>()("UserMessage", {
  id: InputId.pipe(Schema.withConstructorDefault(makeInputId())),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(Attachment).check(Schema.isMaxLength(maxAttachments)))
}) {}

/**
 * Represents the user's answer to a block.
 *
 * It holds the id of the message the block was on, and the value in the block's answer schema
 * (in its JSON form). A chat UI shows it inside the block rather than as a message.
 *
 * @category schemas
 * @since 0.1.0
 */
export class BlockAnswer extends Schema.TaggedClass<BlockAnswer>()("BlockAnswer", {
  id: InputId,
  messageId: Schema.String,
  kind: Schema.String,
  value: Schema.Unknown
}) {}

/**
 * Represents a specialist run that finished working on a brief.
 *
 * Unless the assistant stopped the run, it is an input, and a turn reads its report and decides
 * what to tell the user. Its id is fixed per run and brief, so it is stored once.
 *
 * @category schemas
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
 * Schema for every input `Assistant.submit` accepts.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Union([UserMessage, BlockAnswer, SpecialistFinished])

/**
 * Represents an input to an assistant.
 *
 * @category models
 * @since 0.1.0
 */
export type Input = typeof Input.Type

/**
 * Schema for the inputs from the chat's user, which are messages and block answers.
 *
 * A turn owes each one a reply. It is also what a chat client usually may submit, since the app's
 * events come from the server.
 *
 * @category schemas
 * @since 0.1.0
 */
export const UserInput = Schema.Union([UserMessage, BlockAnswer])

/**
 * Represents an input from the chat's user.
 *
 * @category models
 * @since 0.1.0
 */
export type UserInput = typeof UserInput.Type

/**
 * Represents the UI shown with a message, as a block kind from the assistant's `BlockKit` and its
 * props.
 *
 * @category schemas
 * @since 0.1.0
 */
export class MessageBlock extends Schema.Class<MessageBlock>("effect-assistant/MessageBlock")({
  kind: Schema.String,
  props: Schema.Unknown
}) {}

/**
 * Represents a message the assistant sent the user with `send_user_message`, optionally with a
 * block.
 *
 * @category schemas
 * @since 0.1.0
 */
export class AssistantMessage extends Schema.TaggedClass<AssistantMessage>()("AssistantMessage", {
  id: Schema.String,
  text: Schema.String,
  block: Schema.optional(MessageBlock),
  /** Earlier messages whose block the user answered by typing instead. Their blocks close. */
  closes: Schema.optional(Schema.Array(Schema.String))
}) {}

/**
 * Schema for a tool call the model made.
 *
 * It is `effect/ai`'s tool call part (`Response.ToolCallPart`) for any tool, with its params in
 * JSON, as the model wrote them.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ToolCallPart = Schema.Struct({
  ...Response.ToolCallPart("", Schema.Json).fields,
  name: Schema.String
}).annotate({ identifier: "ToolCallPart" })

/**
 * Represents a tool call the model made.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolCallPart = typeof ToolCallPart.Type

/**
 * Schema for what the log keeps of a model call.
 *
 * It uses `effect/ai`'s response parts for text, reasoning (with the provider's metadata, such as
 * a thinking block's signature), and tool calls.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ModelPart = Schema.Union([Response.TextPart, Response.ReasoningPart, ToolCallPart])

/**
 * Represents a part of a model call's output.
 *
 * @category models
 * @since 0.1.0
 */
export type ModelPart = typeof ModelPart.Type

/**
 * Represents what one model call wrote, as response parts for text, reasoning, and tool calls.
 *
 * `Prompt.fromResponseParts` turns the parts into history.
 *
 * @category schemas
 * @since 0.1.0
 */
export class ModelOutput extends Schema.TaggedClass<ModelOutput>()("ModelOutput", {
  parts: Schema.Array(ModelPart),
  /**
   * The last entry the model had read when it wrote this. Inputs after it
   * arrived while the model was working. A turn has handled what its
   * outputs had read.
   */
  seenThroughSeq: Schema.optional(Schema.Int),
  /** The model that wrote it, as the provider's id for it or the name the context gave it. */
  model: Schema.optional(Schema.String),
  /** The provider's id for the response, when it gives one. */
  responseId: Schema.optional(Schema.String),
  /** The call's token usage, with input (including the cache's reads and writes) and output. */
  usage: Schema.optional(Response.Usage),
  /** How long the call took, in milliseconds. */
  durationMillis: Schema.optional(Schema.Finite)
}) {}

/**
 * Represents a tool call that is about to run.
 *
 * It is stored before the tool runs, so after a crash the log says which calls may have done
 * something. Those calls run again with the same call id (see `AssistantToolCall`).
 *
 * @category schemas
 * @since 0.1.0
 */
export class ToolStarted extends Schema.TaggedClass<ToolStarted>()("ToolStarted", {
  callId: Schema.String,
  tool: Schema.String
}) {}

/**
 * Schema for how a tool call went, either `"success"` or `"failure"`, which the model reads as an
 * error.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ToolOutcome = Schema.Literals(["success", "failure"])

/**
 * Represents how a tool call went.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolOutcome = typeof ToolOutcome.Type

/**
 * Represents the result of one tool call, as the model reads it.
 *
 * It holds the tool's success or failure in its encoded (JSON) form, and which of the two it is. A
 * failure includes its reason when it has one, which is a `ToolFailure`'s `reason` or the
 * failure's tag.
 *
 * @category schemas
 * @since 0.1.0
 */
export class ToolResult extends Schema.TaggedClass<ToolResult>()("ToolResult", {
  callId: Schema.String,
  tool: Schema.String,
  outcome: ToolOutcome,
  result: Schema.Json,
  reason: Schema.optional(Schema.String)
}) {}

/**
 * Represents the start of a turn.
 *
 * @category schemas
 * @since 0.1.0
 */
export class TurnStarted extends Schema.TaggedClass<TurnStarted>()("TurnStarted", {
  /** The assistant that runs it. */
  assistant: Schema.String,
  /**
   * The id of the turn's trace, when a tracer records it (not Effect's own, which exports nothing).
   */
  traceId: Schema.optional(Schema.String)
}) {}

/**
 * Represents a turn that finished.
 *
 * `throughSeq` is the last entry the turn read. Inputs after it still need a turn.
 *
 * @category schemas
 * @since 0.1.0
 */
export class TurnCompleted extends Schema.TaggedClass<TurnCompleted>()("TurnCompleted", {
  throughSeq: Schema.Int
}) {}

/**
 * Represents a turn that failed.
 *
 * `throughSeq` covers everything stored when the turn failed, so a failing input isn't retried
 * forever.
 *
 * @category schemas
 * @since 0.1.0
 */
export class TurnFailed extends Schema.TaggedClass<TurnFailed>()("TurnFailed", {
  throughSeq: Schema.Int,
  message: Schema.String
}) {}

/**
 * Represents a specialist run that started working, either spawned or continued by a follow-up
 * message.
 *
 * The model doesn't see it, since the call that started the run says so, and the run's report
 * arrives as a {@link SpecialistFinished}.
 *
 * @category schemas
 * @since 0.1.0
 */
export class SpecialistStarted extends Schema.TaggedClass<SpecialistStarted>()("SpecialistStarted", {
  runId: RunId,
  specialist: Schema.String,
  /** The goal it's working on. */
  goal: Schema.String
}) {}

/**
 * Represents the deletion of a chat.
 *
 * The chat stores nothing after it, the work running in the chat stopped, and its subscribers'
 * streams end here. Its log stays.
 *
 * @category schemas
 * @since 0.1.0
 */
export class ChatDeleted extends Schema.TaggedClass<ChatDeleted>()("ChatDeleted", {}) {}

/**
 * Represents blocks that closed without an answer, like the ones `BlockKit.closeStale` closes
 * from a turn once the user moved on.
 *
 * The model doesn't see it.
 *
 * @category schemas
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
  ChatDeleted
])

/**
 * Represents an event the library defines.
 *
 * @category models
 * @since 0.1.0
 */
export type AssistantEvent = typeof AssistantEvent.Type

const libraryTags: ReadonlySet<string> = new Set(
  AssistantEvent.members.map((member) => member.fields._tag.schema.literal)
)

/**
 * Schema for the tag of one of the application's own events.
 *
 * It accepts any tag but the library's, and it is branded, so narrowing an entry's event to one
 * of the library's events (`Predicate.isTagged(event, "UserMessage")`) never leaves an app event
 * in.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AppTag = Schema.String.pipe(Schema.brand("~effect-assistant/AppTag"))

/**
 * Schema for one of the application's own events as it is stored, with its `_tag` and its fields
 * in JSON.
 *
 * An assistant made with `events: [AppEvent.make(Summary)]` decodes it to a `Summary` in
 * `CurrentChat`'s `entries` and in its `subscribe`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const StoredAppEvent = Schema.StructWithRest(Schema.Struct({ _tag: AppTag }), [
  Schema.Record(Schema.String, Schema.Json)
]).check(Schema.makeFilter((event) => !libraryTags.has(event._tag) || `${event._tag} is one of the library's events`))

/**
 * Represents one of the application's own events, as it is stored.
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
 * Represents a chat's entry with any event in it, either the library's or the application's own
 * (decoded or not).
 *
 * The folds over a chat take this type, so a client's typed entries fit too.
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
 * Schema for a stored event with its position in the chat.
 *
 * `seq` starts at 1 and has no gaps. `at` is the time the event was stored, in epoch
 * milliseconds.
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
 * Represents a stored event with its position in the chat.
 *
 * @category models
 * @since 0.1.0
 */
export type Entry = typeof Entry.Type

/**
 * Returns whether an event is one of the library's inputs, which are a user message, a block
 * answer, or a finished specialist run.
 *
 * The application's events that wake a turn are inputs too, but only their assistant knows which
 * (see `AppEvent`).
 *
 * @category guards
 * @since 0.1.0
 */
export const isInput = (event: { readonly _tag: string }): event is Input =>
  Predicate.isTagged(event, "UserMessage") ||
  Predicate.isTagged(event, "BlockAnswer") ||
  Predicate.isTagged(event, "SpecialistFinished")

/**
 * Returns whether an input starts a turn, which every input does except a run the assistant
 * stopped itself.
 *
 * @category guards
 * @since 0.1.0
 */
export const isWaking = (input: Input): boolean =>
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
 * @category utils
 * @since 0.1.0
 */
export const assistantTexts = (entries: ReadonlyArray<AnyEntry>): ReadonlyArray<string> =>
  entries.flatMap(({ event }) =>
    isLibraryEvent(event) && Predicate.isTagged(event, "AssistantMessage") ? [event.text] : []
  )
