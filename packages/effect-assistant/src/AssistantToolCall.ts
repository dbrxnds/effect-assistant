/**
 * The `AssistantToolCall` module gives a tool the call it runs for: its id,
 * and a key for anything it does outside the chat.
 *
 * A tool call runs at least once. If the process stops while a call runs,
 * the next turn runs it again, with the same call id, before the model goes
 * on. A tool that orders, sends, or writes something passes
 * {@link idempotencyKey} to whatever does it (a workflow's idempotency key,
 * a payment's key), so the second run finds the first one's work instead of
 * doing it twice.
 *
 * A tool that can't do that, like one that sends an email, is marked
 * {@link destructive}: a call of it that a crash cut off isn't run again. The
 * model gets a result saying it may have run, and checks before trying
 * again. The name follows MCP's `destructiveHint`.
 *
 * **Example** (A tool that starts a workflow once per call)
 *
 * ```ts
 * import * as Tool from "@effect-uai/core/Tool"
 * import * as Effect from "effect/Effect"
 * import { AssistantToolCall, RunId } from "effect-assistant"
 *
 * const placeOrder = Tool.make({
 *   name: "place_order",
 *   description: "Places the order the user confirmed.",
 *   inputSchema: OrderInput,
 *   run: Effect.fn(function*(input: typeof OrderInput.Type) {
 *     // The same run id every time this call runs.
 *     const runId = RunId.fromKey(yield* AssistantToolCall.idempotencyKey)
 *     yield* ProductOrder.execute({ runId, ...input }, { discard: true })
 *
 *     return { runId }
 *   })
 * })
 * ```
 *
 * @since 0.1.0
 */
import type * as Tool from "@effect-uai/core/Tool"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"

/**
 * Service for the tool call a tool runs for. The agent loop provides it to
 * every call.
 *
 * @category services
 * @since 0.1.0
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
 *
 * @category accessors
 * @since 0.1.0
 */
export const idempotencyKey: Effect.Effect<string, never, AssistantToolCall> = AssistantToolCall.useSync(
  (call) => `tool-call:${call.callId}`
)

const DestructiveId = "~effect-assistant/AssistantToolCall/destructive"

/**
 * Marks a tool as destructive: it changes something it can't safely do twice.
 * A call of it that a crash cut off isn't run again; the model is told it may
 * have run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const destructive = <T extends Tool.AnyTool>(tool: T): T & { readonly [DestructiveId]: true } => ({
  ...tool,
  [DestructiveId]: true
})

/**
 * Whether a tool is marked {@link destructive}.
 *
 * @category guards
 * @since 0.1.0
 */
export const isDestructive = (tool: Tool.AnyTool | undefined): boolean =>
  tool !== undefined && Predicate.hasProperty(tool, DestructiveId) && tool[DestructiveId] === true
