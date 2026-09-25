/**
 * The `AssistantChat` module gives a handler's build the chat it's building
 * for.
 *
 * An assistant's (or a specialist's) build Effect runs once per chat
 * activation, like an Effect cluster entity's: when the chat wakes up (a
 * message, a specialist's report, a workflow's fact), and its scope closes
 * when the chat goes idle. What the build sets up, like the chat's user or a
 * resource with a finalizer, lives as long as the chat is active. The
 * function it returns runs every turn.
 *
 * **Example** (Looking the chat's user up once per activation)
 *
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Stream from "effect/Stream"
 * import { AssistantChat } from "effect-assistant"
 *
 * const MyAssistantHandlers = MyAssistant.toLayer(Effect.gen(function*() {
 *   const { chatId } = yield* AssistantChat.AssistantChat
 *   const user = yield* (yield* ChatUsers).forChat(chatId)
 *
 *   return (turn) =>
 *     turn.loop({ model: "claude-sonnet-5", instructions: `You help ${user.name}.` }).pipe(
 *       Stream.provideService(CurrentUser, user)
 *     )
 * }))
 * ```
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type { ChatId } from "./ChatId.ts"

/**
 * Service for the chat a handler's build runs for. The engine provides it to
 * every build.
 *
 * @category services
 * @since 0.1.0
 */
export class AssistantChat extends Context.Service<
  AssistantChat,
  {
    readonly chatId: ChatId
  }
>()("effect-assistant/AssistantChat") {}
