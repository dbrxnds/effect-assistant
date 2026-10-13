/**
 * This module provides the `CurrentChat` service, which gives code that runs inside a chat
 * access to that chat: its id, its entries, and a way to append to it.
 *
 * A turn's handler, its tools, and its specialists' runs get the chat with `yield* CurrentChat`.
 * Inside a specialist's run, it is the chat the run belongs to, which is the chat of the turn
 * that spawned the run. The service doesn't carry an assistant's event types, so code that
 * doesn't know the assistant, such as a shared tool, can use it. Code that knows the assistant
 * can use `MyAssistant.Chat`, which is the same chat typed with the assistant's events.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as AssistantEvent from "./AssistantEvent.ts"
import type { ChatId } from "./ChatId.ts"

/**
 * Service that represents the chat the current code runs in.
 *
 * **Details**
 *
 * In a turn, it is the chat the turn runs in. In a specialist's run, and in its handler's build,
 * it is the chat the run belongs to: the chat of the turn that spawned the run. A run's tools
 * read and append to that chat.
 *
 * @category services
 * @since 0.1.0
 */
export class CurrentChat extends Context.Service<
  CurrentChat,
  {
    readonly chatId: ChatId
    /**
     * The chat's entries so far, in order. They include the library's events and the assistant's
     * own events, decoded; check for these with `Schema.is(MyEvent)` or `instanceof`. An app event
     * that no longer decodes is left out.
     */
    readonly entries: Effect.Effect<ReadonlyArray<AssistantEvent.AnyEntry>>
    /**
     * Appends events after the chat's last entry and sends them to the chat's subscribers. The
     * events can be the library's or the assistant's own (registered with its `events` option),
     * such as a summary. An app event appended here wakes no turn: only one that comes in through
     * the assistant's `submit` does.
     */
    readonly append: (...events: ReadonlyArray<{ readonly _tag: string }>) => Effect.Effect<void>
  }
>()("effect-assistant/CurrentChat") {}
