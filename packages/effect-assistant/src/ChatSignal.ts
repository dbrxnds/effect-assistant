/**
 * This module provides the signals a chat sends its live subscribers while a turn works: a short
 * status of what the assistant is doing, and whether it is writing a message to the user.
 *
 * Signals are never stored. They reach only the subscribers that are listening when they are sent
 * (`assistant.subscribe(chatId, { signals: true })`), between the chat's entries and in order with
 * them. A turn's model never reads them, compaction never sees them, and a client that loads the
 * chat again starts without them. The turn itself shows in the log, from its `TurnStarted` to its
 * `TurnCompleted` or `TurnFailed`.
 *
 * A status goes when the call it describes ends ({@link StatusCleared}), when the next one replaces
 * it, when typing hides it, or when the turn ends. Typing stops before the turn ends, also when it
 * fails, so neither outlives its turn.
 *
 * @since 0.13.0
 */
import * as Schema from "effect/Schema"

/**
 * Represents the line the chat shows next to the assistant while a turn works, like "Checking
 * last summer's campaign budget". The latest one shows until it's cleared, until the next, until
 * the model starts writing to the user, or until the turn ends.
 *
 * @category schemas
 * @since 0.13.0
 */
export class Status extends Schema.TaggedClass<Status>()("Status", {
  text: Schema.String
}) {}

/**
 * Represents the end of the call the line described, with no other described call still running:
 * the line goes.
 *
 * @category schemas
 * @since 0.19.0
 */
export class StatusCleared extends Schema.TaggedClass<StatusCleared>()("StatusCleared", {}) {}

/**
 * Represents the model starting to write a message to the user. The status line goes: the user
 * sees the message coming instead.
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
export const ChatSignal = Schema.Union([Status, StatusCleared, TypingStarted, TypingStopped])

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
