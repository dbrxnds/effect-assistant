import type * as Effect from "effect/Effect"
import type * as AssistantEvent from "../AssistantEvent.ts"
import type { ChatId } from "../ChatId.ts"
import type { ChatSignal } from "../ChatSignal.ts"

/** @internal */
export interface Writer {
  readonly chatId: ChatId
  readonly entries: Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
  readonly append: (
    events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>
  ) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
  // Sent to the live subscribers only, never stored.
  readonly signal: (signal: ChatSignal) => Effect.Effect<void>
}
