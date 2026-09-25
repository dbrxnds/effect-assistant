/**
 * The `ChatId` module defines the id of one conversation: `chat:` followed by
 * a nanoid. A chat id keys everything about a chat: its event log, its cluster
 * entity, and its trace session.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Nanoid from "./internal/nanoid.ts"

/**
 * Schema for chat ids: `` `chat:${nanoid}` ``, branded so a run id or a plain
 * string can't be passed where a chat id is required.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ChatId = Schema.TemplateLiteral(["chat:", Nanoid.Nanoid]).pipe(Schema.brand("effect-assistant/ChatId"))

/**
 * A chat id.
 *
 * @category models
 * @since 0.1.0
 */
export type ChatId = typeof ChatId.Type

/**
 * Creates a new random chat id.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (): ChatId => Schema.decodeSync(ChatId)(`chat:${Nanoid.make()}`)
