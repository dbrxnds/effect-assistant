/**
 * The `AssistantChat` module gives code that runs in a chat that chat: its
 * id, its entries, and a way to add to it. A turn's handler, its tools, and
 * its specialists' runs get it with `yield* AssistantChat`.
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as AssistantEvent from "./AssistantEvent.ts"
import type { ChatId } from "./ChatId.ts"

/** Service for the chat that code runs in. */
export class AssistantChat extends Context.Service<
  AssistantChat,
  {
    readonly chatId: ChatId
    /**
     * The chat's entries so far, in order: the library's events, and the
     * assistant's own, decoded (read them with `Schema.is(MyEvent)` or
     * `instanceof`). An app event that no longer decodes is left out.
     */
    readonly entries: Effect.Effect<ReadonlyArray<AssistantEvent.AnyEntry>>
    /**
     * Appends events after the chat's last entry and sends them to its
     * subscribers: the library's, or the assistant's own (registered with its
     * `events`), like a summary. One that wakes a turn gets the next turn.
     */
    readonly append: (...events: ReadonlyArray<{ readonly _tag: string }>) => Effect.Effect<void>
  }
>()("effect-assistant/AssistantChat") {}
