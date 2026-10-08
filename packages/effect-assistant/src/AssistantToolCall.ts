/**
 * The `AssistantToolCall` module gives a tool the call it runs for: its id,
 * and a key for anything it does outside the chat.
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

/**
 * Service for the tool call a tool runs for. The agent loop provides it to
 * every call.
 */
export class AssistantToolCall extends Context.Service<
  AssistantToolCall,
  {
    /** The call's id, as the model wrote it. The same when the call runs again after a crash. */
    readonly callId: string
    /** The tool's name. */
    readonly tool: string
  }
>()("effect-assistant/AssistantToolCall") {}

/**
 * A key for what this call does outside the chat: the same every time the
 * call runs, and different for every other call.
 */
export const idempotencyKey: Effect.Effect<string, never, AssistantToolCall> = AssistantToolCall.useSync(
  (call) => `tool-call:${call.callId}`
)
