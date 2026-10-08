/**
 * The `AssistantLoop` module is the agent loop: call the model, run its tool
 * calls, repeat. `turn.loop` and `run.loop` are what most handlers need; this
 * is for a loop of your own: {@link run} runs it until the model is done, and
 * {@link step} is one step, as a body for {@link loop}.
 *
 * Tools are a native toolkit (`effect/ai/Toolkit`), with its handlers from the
 * handler's layer. In a turn, the assistant's own tools (`send_user_message`,
 * `wait`, the specialist tools) come with them.
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
 * What the loop produces: each model call's output, then for each of its tool
 * calls a `ToolStarted` before it runs and its result, or, for a call that
 * waits for the user's decision, its `DecisionRequested`.
 */
export type Event = Loop.Event

/** A chat's history as the model reads it: its messages, and the last `seq` of the chat they cover. */
export type ChatHistory = Loop.ChatHistory

/** How a step went, for deciding what comes next. */
export type StepResult = Loop.StepResult

/** What a loop body emits: a value, or what to do next. */
export type Step<A, S> = Loop.Step<A, S>

/** Emits a value from a loop body. */
export const value = Loop.value

/** Ends a loop body's step and goes on with this state. */
export const next = Loop.next

/** Ends the loop. */
export const stop = Loop.stop

/**
 * Runs a loop body from a state: emits its values, and runs it again with the
 * state it goes `next` with, until it `stop`s.
 */
export const loop = Loop.loop

/** No tools. */
type NoTools = Record<never, never>

/** What a toolkit's tools need when they run: their handlers, and what those use. */
export type ToolkitServices<T extends Record<string, Tool.Any>> = Tool.HandlersFor<T> | Toolkits.ToolServices<T>

/** Options for {@link step}. */
export interface StepOptions<T extends Record<string, Tool.Any> = NoTools> {
  /** The full system prompt, like `turn.instructions(text)`, optionally with span attributes. */
  readonly instructions: string | Instructions.Resolved
  /** The tools the model can call, next to the assistant's own in a turn. Its handlers come from the layer. */
  readonly toolkit?: Toolkit.Toolkit<T> | undefined
  /**
   * The current history, read at the start of the step: messages, or a
   * chat's history (`turn.history()`), whose `throughSeq` the step's
   * `ModelOutput` records as how far the model had read.
   */
  readonly history: Effect.Effect<ReadonlyArray<Prompt.Message> | ChatHistory>
  /**
   * Default `"auto"`: a step without a tool call ends the loop. Forcing a
   * call (`"required"`, or a tool by name) is refused by newer models, and
   * with extended thinking.
   */
  readonly toolChoice?: LanguageModel.ToolChoice<string> | undefined
}

/** Options for {@link run}. */
export interface Options<T extends Record<string, Tool.Any> = NoTools> extends StepOptions<T> {
  /** Model calls allowed. Default 16. */
  readonly maxSteps?: number | undefined
}

/** The toolkit as the loop runs it, with the turn's own tools when there is a turn. */
const toolsOf = <T extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<T> | undefined) =>
  Effect.map(Loop.TurnTools, (turn) => {
    const own = toolkit === undefined ? Toolkits.empty : Toolkits.fromToolkit(toolkit)

    return Option.match(turn, { onNone: () => own, onSome: (builtins) => Toolkits.merge(builtins, own) })
  })

/**
 * One step of the agent loop, as a body for {@link loop}: it calls the model
 * with the current history and emits its `ModelOutput`, then runs the
 * output's tool calls and emits a `ToolStarted` and a `ToolResult` for each,
 * or a `DecisionRequested` for one that waits for the user's decision.
 * `then` decides what comes next: `AssistantLoop.next(state)` or
 * `AssistantLoop.stop()`.
 */
export const step = <T extends Record<string, Tool.Any> = NoTools, S = never, E2 = never, R2 = never>(
  options: StepOptions<T>,
  then: (result: StepResult) => Stream.Stream<Step<never, S>, E2, R2>
): Stream.Stream<Step<Event, S>, AiError.AiError | E2, LanguageModel.LanguageModel | ToolkitServices<T> | R2> =>
  Stream.unwrap(Effect.map(toolsOf(options.toolkit), (toolkit) => Loop.step({ ...options, toolkit }, then)))

/**
 * Runs the agent loop as a stream: {@link step} after step, until the model
 * is done and nothing new arrived while it worked, or after `maxSteps` model
 * calls.
 */
export const run = <T extends Record<string, Tool.Any> = NoTools>(
  options: Options<T>
): Stream.Stream<Event, AiError.AiError, LanguageModel.LanguageModel | ToolkitServices<T>> =>
  Stream.unwrap(Effect.map(toolsOf(options.toolkit), (toolkit) => Loop.run({ ...options, toolkit })))
