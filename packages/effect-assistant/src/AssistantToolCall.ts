/**
 * Gives a tool the call it runs for.
 *
 * The {@link AssistantToolCall} service holds the call's id and the tool's name, and
 * {@link idempotencyKey} derives a key for anything the call does outside the chat.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

/**
 * Service that describes the tool call a tool runs for.
 *
 * The agent loop provides it to every call.
 *
 * @category services
 * @since 0.1.0
 */
export class AssistantToolCall extends Context.Service<
  AssistantToolCall,
  {
    /** The call's id, as the model wrote it. It stays the same when a crash runs the call again. */
    readonly callId: string
    /** The tool's name. */
    readonly tool: string
  }
>()("effect-assistant/AssistantToolCall") {}

/**
 * Gets an idempotency key for what the current tool call does outside the chat.
 *
 * The key is the same every time the call runs, and different for every other call.
 *
 * @category accessors
 * @since 0.1.0
 */
export const idempotencyKey: Effect.Effect<string, never, AssistantToolCall> = AssistantToolCall.useSync(
  (call) => `tool-call:${call.callId}`
)
