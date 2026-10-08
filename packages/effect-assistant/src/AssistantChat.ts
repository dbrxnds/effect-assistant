/**
 * The `AssistantChat` module gives code that runs in a chat that chat: its
 * id, its entries, and a way to add to it.
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
    /** The chat's entries so far, in order. */
    readonly entries: Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
    /**
     * Appends events after the chat's last entry, sends them to its subscribers, and returns them as stored.
     */
    readonly append: (
      events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>
    ) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
  }
>()("effect-assistant/AssistantChat") {}
