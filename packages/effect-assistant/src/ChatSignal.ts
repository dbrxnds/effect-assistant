/**
 * This module provides the signals a chat sends its live subscribers while a turn works: a short
 * status of what the assistant is doing, and whether it is writing a message to the user.
 *
 * Signals are never stored. They reach only the subscribers that are listening when they are sent
 * (`assistant.subscribe(chatId, { live: true })`), between the chat's entries and in order with
 * them. A turn's model never reads them, compaction never sees them, and a client that loads the
 * chat again starts without them. The turn itself shows in the log, from its `TurnStarted` to its
 * `TurnCompleted` or `TurnFailed`.
 *
 * A turn clears what it showed before it ends, also when it fails: a status and the typing
 * indicator never outlive their turn.
 *
 * @since 0.13.0
 */
import * as Schema from "effect/Schema"

/**
 * Schema for where a status comes from: a tool call that is running (`tool`), or a short summary of
 * the turn so far, for a turn that runs a while with nothing else to show (`summary`).
 *
 * @category schemas
 * @since 0.13.0
 */
export const StatusSource = Schema.Literals(["tool", "summary"])

/**
 * Represents where a status comes from.
 *
 * @category models
 * @since 0.13.0
 */
export type StatusSource = typeof StatusSource.Type

/**
 * Represents a status the chat shows next to the assistant, like "Checking last summer's campaign
 * budget". `key` names it until a {@link StatusCleared} with the same key: a tool call's status has
 * the call's id.
 *
 * @category schemas
 * @since 0.13.0
 */
export class StatusShown extends Schema.TaggedClass<StatusShown>()("StatusShown", {
  key: Schema.String,
  text: Schema.String,
  source: StatusSource
}) {}

/**
 * Represents a status that no longer applies, because its call ended or a message arrived.
 *
 * @category schemas
 * @since 0.13.0
 */
export class StatusCleared extends Schema.TaggedClass<StatusCleared>()("StatusCleared", {
  key: Schema.String
}) {}

/**
 * Represents the model starting to write a message to the user.
 *
 * @category schemas
 * @since 0.13.0
 */
export class TypingStarted extends Schema.TaggedClass<TypingStarted>()("TypingStarted", {}) {}

/**
 * Represents the end of the typing: the message is in the chat's log, or the model wrote none.
 *
 * @category schemas
 * @since 0.13.0
 */
export class TypingStopped extends Schema.TaggedClass<TypingStopped>()("TypingStopped", {}) {}

/**
 * Schema for any of a chat's signals.
 *
 * @category schemas
 * @since 0.13.0
 */
export const ChatSignal = Schema.Union([StatusShown, StatusCleared, TypingStarted, TypingStopped])

/**
 * Represents any of a chat's signals.
 *
 * @category models
 * @since 0.13.0
 */
export type ChatSignal = typeof ChatSignal.Type

/**
 * Returns whether a value is one of a chat's signals, such as an item of a live subscription that
 * isn't an entry.
 *
 * @category guards
 * @since 0.13.0
 */
export const isChatSignal: (u: unknown) => u is ChatSignal = Schema.is(ChatSignal)
