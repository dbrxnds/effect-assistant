/**
 * The `ChatId` module defines the id of one conversation: `chat:` followed by
 * a UUID. A chat id keys everything about a chat: its log, its cluster
 * entity, and its trace session.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Uuid from "./internal/uuid.ts"

/**
 * Schema for chat ids: `` `chat:${uuid}` ``, branded so a run id or a plain
 * string can't be passed where a chat id is required.
 */
export const ChatId = Schema.TemplateLiteral(["chat:", Uuid.Uuid]).pipe(Schema.brand("effect-assistant/ChatId"))

/** A chat id. */
export type ChatId = typeof ChatId.Type

/** Creates a new random chat id, with Effect's `Random`: seed it in tests for the same ids every run. */
export const make = (): Effect.Effect<ChatId> => Effect.map(Uuid.make, (uuid) => ChatId.make(`chat:${uuid}`))
