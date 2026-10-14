/**
 * Runs the agent loop, which calls the model, runs its tool calls, and repeats.
 *
 * Most handlers use `turn.run` or `run.loop`. This module is for a loop of your own: {@link run}
 * runs the loop until the model is done, and {@link step} is one step, as a body for
 * {@link loop}.
 *
 * Tools are a native toolkit (`effect/ai/Toolkit`) whose handlers come from the handler's layer.
 * In a turn, the assistant's own tools (`send_user_message`, `wait`, and the specialist tools)
 * are added to them.
 *
 * @since 0.1.0
 */
import type * as AiError from "effect/ai/AiError"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Prompt from "effect/ai/Prompt"
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import type * as Instructions from "./Instructions.ts"
import * as Loop from "./internal/loop.ts"
import * as Toolkits from "./internal/toolkit.ts"

/**
 * Represents what the loop emits.
 *
 * For each model call, the loop emits the call's output. Then, for each of its tool calls, it
 * emits a `ToolStarted` before the call runs and the call's result.
 *
 * @category models
 * @since 0.1.0
 */
export type Event = Loop.Event

/**
 * Represents a chat's history as the model reads it.
 *
 * It holds the messages, and the last `sequence` of the chat they cover.
 *
 * @category models
 * @since 0.1.0
 */
export type ChatHistory = Loop.ChatHistory

/**
 * Represents how a step went, for deciding what comes next.
 *
 * @category models
 * @since 0.1.0
 */
export type StepResult = Loop.StepResult

/**
 * Represents what a loop body emits, which is either a value or what to do next.
 *
 * @category models
 * @since 0.1.0
 */
export type Step<A, S> = Loop.Step<A, S>

/**
 * Emits a value from a loop body.
 *
 * @category constructors
 * @since 0.1.0
 */
export const value = Loop.value

/**
 * Ends a loop body's step and continues the loop with the given state.
 *
 * @category constructors
 * @since 0.1.0
 */
export const next = Loop.next

/**
 * Ends the loop.
 *
 * @category constructors
 * @since 0.1.0
 */
export const stop = Loop.stop

/**
 * Runs a loop body from an initial state.
 *
 * It emits the body's values, and runs the body again with the state it passes to `next`, until
 * the body calls `stop`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const loop = Loop.loop

type NoTools = Record<never, never>

/**
 * Extracts the services a toolkit's tools need when they run, which are their handlers and the
 * services those handlers use.
 *
 * @category utility types
 * @since 0.1.0
 */
export type ToolkitServices<T extends Record<string, Tool.Any>> = Tool.HandlersFor<T> | Toolkits.ToolServices<T>

/**
 * Represents the options for {@link step}.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepOptions<T extends Record<string, Tool.Any> = NoTools> {
  /** The full system prompt, like `turn.instructions(text)`, optionally with span attributes. */
  readonly instructions: string | Instructions.Resolved
  /**
   * The tools the model can call, in addition to the assistant's own tools in a turn. Their
   * handlers come from the layer.
   */
  readonly toolkit?: Toolkit.Toolkit<T> | undefined
  /**
   * The current history, read at the start of the step. It is either messages, or a chat's
   * history (`turn.history()`), whose `throughSequence` the step's `ModelOutput` records as how far
   * the model had read.
   */
  readonly history: Effect.Effect<ReadonlyArray<Prompt.Message> | ChatHistory>
  /**
   * Defaults to `"auto"`, where a step without a tool call ends the loop. Forcing a call
   * (`"required"`, or a tool by name) is refused by newer models, and with extended thinking.
   */
  readonly toolChoice?: LanguageModel.ToolChoice<string> | undefined
}

/**
 * Represents the options for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options<T extends Record<string, Tool.Any> = NoTools> extends StepOptions<T> {
  /** The model calls allowed. Defaults to 16. */
  readonly maxSteps?: number | undefined
}

const toolsOf = <T extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<T> | undefined) =>
  Effect.map(Loop.TurnTools, (turn) => {
    const own = toolkit === undefined ? Toolkits.empty : Toolkits.fromToolkit(toolkit)

    return Option.match(turn, { onNone: () => own, onSome: (builtins) => Toolkits.merge(builtins, own) })
  })

/**
 * Runs one step of the agent loop, as a body for {@link loop}.
 *
 * **Details**
 *
 * The step calls the model with the current history and emits its `ModelOutput`. It then runs
 * the output's tool calls and emits a `ToolStarted` and a `ToolResult` for each. `then` receives
 * the step's result and decides what comes next, with `AssistantLoop.next(state)` or
 * `AssistantLoop.stop()`.
 *
 * In a turn's loop, a call to a tool with Effect's `needsApproval` doesn't run: the step emits an
 * `ApprovalRequested` for it, and ends the turn, which waits for the user (see `ToolApproval`). A
 * call the user approved runs at the start of the next step, before the model is called. A
 * specialist's run can't wait for the user: such a call fails, and the run reads why.
 *
 * @category constructors
 * @since 0.1.0
 */
export const step = <T extends Record<string, Tool.Any> = NoTools, S = never, E2 = never, R2 = never>(
  options: StepOptions<T>,
  then: (result: StepResult) => Stream.Stream<Step<never, S>, E2, R2>
): Stream.Stream<Step<Event, S>, AiError.AiError | E2, LanguageModel.LanguageModel | ToolkitServices<T> | R2> =>
  Stream.unwrap(Effect.map(toolsOf(options.toolkit), (toolkit) => Loop.step({ ...options, toolkit }, then)))

/**
 * Runs the agent loop as a stream.
 *
 * **Details**
 *
 * It runs {@link step} after step until the model is done and nothing new arrived while it
 * worked, or until it has made `maxSteps` model calls.
 *
 * **Example** (A turn's loop with a step limit)
 *
 * ```ts
 * import { AssistantLoop } from "effect-assistant"
 * import * as Layer from "effect/Layer"
 * import * as Stream from "effect/Stream"
 *
 * const instructions = "You help a small marketing team."
 *
 * const MyAssistantLive = MyAssistant.toLayer((turn) =>
 *   AssistantLoop.run({
 *     instructions: turn.instructions(instructions),
 *     toolkit: MyTools, // the assistant's own tools are added to them
 *     history: turn.history(),
 *     maxSteps: 12
 *   }).pipe(Stream.concat(turn.replyIfOwed({ instructions })))
 * ).pipe(Layer.provide(MyToolsLive))
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const run = <T extends Record<string, Tool.Any> = NoTools>(
  options: Options<T>
): Stream.Stream<Event, AiError.AiError, LanguageModel.LanguageModel | ToolkitServices<T>> =>
  Stream.unwrap(Effect.map(toolsOf(options.toolkit), (toolkit) => Loop.run({ ...options, toolkit })))
