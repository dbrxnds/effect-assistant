/**
 * This module provides the id of a chat, which is `chat:` followed by a UUID.
 *
 * A chat id keys everything about a chat: its log, its cluster entity, and its trace session.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Uuid from "./internal/uuid.ts"

/**
 * Schema for chat ids of the form `` `chat:${uuid}` ``. The schema is branded, so a run id or a
 * plain string can't be passed where a chat id is required.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ChatId = Schema.TemplateLiteral(["chat:", Uuid.Uuid]).pipe(Schema.brand("effect-assistant/ChatId"))

/**
 * Represents a chat id.
 *
 * @category models
 * @since 0.1.0
 */
export type ChatId = typeof ChatId.Type

/**
 * Creates a new random chat id using Effect's `Random`. Seed `Random` in tests to get the same ids
 * on every run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (): Effect.Effect<ChatId> => Effect.map(Uuid.make, (uuid) => ChatId.make(`chat:${uuid}`))
