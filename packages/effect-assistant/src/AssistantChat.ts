/**
 * The `AssistantChat` module gives code that runs in a chat that chat: its
 * id, its entries, and a way to add to it.
 *
 * The engine provides it to everything that runs for a chat: a handler's
 * build (once per chat activation), each turn's loop and tools, and the
 * chat's specialist runs. Its `append` is the chat's only writer: appends go
 * one at a time, each numbered after the last, and reach the chat's
 * subscribers.
 *
 * **Example** (A tool that reads the chat)
 *
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import * as Tool from "effect/unstable/ai/Tool"
 * import * as Toolkit from "effect/unstable/ai/Toolkit"
 * import { AssistantChat } from "effect-assistant"
 *
 * const CountMessages = Tool.make("count_messages", {
 *   description: "How many messages this chat has.",
 *   success: Schema.Int,
 *   dependencies: [AssistantChat.AssistantChat]
 * })
 *
 * const ChatToolsLive = Toolkit.make(CountMessages).toLayer({
 *   count_messages: () =>
 *     Effect.gen(function*() {
 *       const entries = yield* (yield* AssistantChat.AssistantChat).entries
 *
 *       return entries.filter((entry) => Predicate.isTagged(entry.event, "UserMessage")).length
 *     })
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as AssistantEvent from "./AssistantEvent.ts"
import type { ChatId } from "./ChatId.ts"

/**
 * Service for the chat that code runs in.
 *
 * @category services
 * @since 0.1.0
 */
export class AssistantChat extends Context.Service<
  AssistantChat,
  {
    readonly chatId: ChatId
    /** The chat's entries so far, in order. */
    readonly entries: Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
    /** Appends events after the chat's last entry, sends them to its subscribers, and returns them as stored. */
    readonly append: (
      events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>
    ) => Effect.Effect<ReadonlyArray<AssistantEvent.Entry>>
  }
>()("effect-assistant/AssistantChat") {}
