/** A chat's writer, as the library uses it: stored events in, stored entries out. */
import type * as Effect from "effect/Effect"
import type * as AssistantEvent from "../AssistantEvent.ts"
import type { ChatId } from "../ChatId.ts"

export interface Writer {
  readonly chatId: ChatId
  /** The chat's entries so far, in order, as stored. */
  readonly entries: Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
  /** Appends stored events after the chat's last entry, sends them to its subscribers, and returns them. */
  readonly append: (
    events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>
  ) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
}
