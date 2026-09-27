/**
 * The `AssistantLoop` module is the agent loop: call the model, run its tool
 * calls, repeat. {@link stream} runs it as a `Stream` of what happened, one
 * step at a time, on effect-uai's `Loop`. An assistant's handler and a specialist's handler both
 * return one, usually through `turn.loop` or `run.loop`, which wire in the
 * rest.
 *
 * History is read fresh before every model call, so a message the user sends
 * mid-turn is seen at the next step. That is what makes an assistant a
 * colleague you can interrupt rather than a request/response endpoint.
 *
 * **Pull-based**
 *
 * The stream runs a step only when it is pulled, and whoever consumes it
 * (the assistant's runner) records each event before pulling the next. That
 * is how the next step's `history` includes the last one. Don't buffer it
 * ahead (`Stream.buffer`) or run it twice.
 *
 * **Example** (A handler that runs the loop itself)
 *
 * ```ts
 * import { AssistantLoop } from "effect-assistant"
 *
 * const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
 *   AssistantLoop.stream({
 *     model: "claude-sonnet-5",
 *     instructions: turn.instructions("You help a small team."),
 *     toolkit: { ...turn.tools, ...toolkit },
 *     history: turn.history(),
 *     toolChoice: "required"
 *   })
 * )
 * ```
 *
 * @since 0.1.0
 */
import type * as AiError from "@effect-uai/core/AiError"
import * as HistoryCheck from "@effect-uai/core/HistoryCheck"
import * as Items from "@effect-uai/core/Items"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as Loop from "@effect-uai/core/Loop"
import type * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as ToolResultWire from "@effect-uai/core/ToolResult"
import * as Turn from "@effect-uai/core/Turn"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import * as AssistantEvent from "./AssistantEvent.ts"
import { AssistantToolCall } from "./AssistantToolCall.ts"
import type * as Instructions from "./Instructions.ts"
import * as Telemetry from "./internal/telemetry.ts"
import { endsTurn } from "./internal/tools.ts"

/**
 * What the loop produces: each model call's output, then for each of its tool
 * calls a `ToolStarted` before it runs and its result.
 *
 * @category models
 * @since 0.1.0
 */
export type Event = AssistantEvent.ModelOutput | AssistantEvent.ToolStarted | AssistantEvent.ToolResult

/**
 * What a toolkit's tools need to run, besides the call the loop provides.
 *
 * @category utility types
 * @since 0.1.0
 */
export type ToolServices<Tools extends Toolkit.Toolkit> = Exclude<Toolkit.ToolkitR<Tools>, AssistantToolCall>

/**
 * How a toolkit's tools can fail, besides the failures the model sees as results.
 *
 * @category utility types
 * @since 0.1.0
 */
export type ToolErrors<Tools extends Toolkit.Toolkit> = Exclude<Toolkit.ToolkitE<Tools>, string | Tool.ToolFailed>

/**
 * Options for {@link step}.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepOptions<Tools extends Toolkit.Toolkit = Toolkit.Toolkit> {
  /** The model to call, as the `LanguageModel` in context names it (e.g. `"claude-sonnet-5"`). */
  readonly model: string
  /** The full system prompt, like `turn.instructions(text)`, optionally with span attributes. */
  readonly instructions: string | Instructions.Resolved
  readonly toolkit: Tools
  /** The current history, read at the start of the step. */
  readonly history: Effect.Effect<ReadonlyArray<Items.HistoryItem>>
  /** `"required"` makes every step a tool call: assistants talk only through tools. */
  readonly toolChoice?: LanguageModel.CommonRequest["toolChoice"] | undefined
}

/**
 * Options for {@link stream}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options<Tools extends Toolkit.Toolkit = Toolkit.Toolkit> extends StepOptions<Tools> {
  /** Model calls allowed. Default 16. */
  readonly maxSteps?: number | undefined
}

/**
 * How a step went, for deciding what comes next.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepResult {
  /** The model's output; unset when the step only ran calls a crash cut off. */
  readonly output: AssistantEvent.ModelOutput | undefined
  /**
   * Whether the model is done: it made no tool calls, or ended its turn (`wait`, or a message
   * with `wait: true`) and none of the step's calls failed.
   */
  readonly done: boolean
  /** The history's length with this step's output and results: a longer one got something new meanwhile. */
  readonly historyLength: number
}

/**
 * A tool call with no input can arrive with `arguments: ""`. Store `"{}"`
 * instead: the Anthropic adapter parses arguments when it sends history back,
 * and `""` isn't JSON.
 */
const withJsonArguments = (item: Items.HistoryItem): Items.HistoryItem =>
  Items.isToolCall(item) && item.arguments.trim() === "" ? { ...item, arguments: "{}" } : item

/** Runs one call through the toolkit, in its own span, with the call as `AssistantToolCall`. */
const runCall = <Tools extends Toolkit.Toolkit>(toolkit: Tools, call: Items.ToolCall) =>
  Toolkit.collectResults(Toolkit.run(toolkit, [call])).pipe(
    Effect.provideService(AssistantToolCall, { callId: call.call_id, tool: call.name }),
    Effect.map((results) =>
      results.map((result) => {
        const wire = ToolResultWire.toToolCallOutput(result)

        return {
          event: AssistantEvent.ToolResult.make({
            callId: wire.call_id,
            tool: call.name,
            output: wire.output
          }),
          failed: ToolResultWire.isFailure(result)
        }
      })
    ),
    Effect.tap((results) => Telemetry.toolOutput(results.map((result) => result.event.output).join("\n"))),
    Telemetry.toolSpan(call)
  )

/**
 * Runs the calls: first a `ToolStarted` for each (stored before any runs), then their results,
 * concurrently, then `then`, told whether any of them failed.
 */
const runCalls = <Tools extends Toolkit.Toolkit, S, E, R>(
  toolkit: Tools,
  calls: ReadonlyArray<Items.ToolCall>,
  then: (failed: boolean) => Stream.Stream<Loop.Step<never, S>, E, R>
) =>
  Stream.fromIterable(
    calls.map((call) => Loop.value(AssistantEvent.ToolStarted.make({ callId: call.call_id, tool: call.name })))
  ).pipe(
    Stream.concat(
      Stream.unwrap(
        Effect.map(
          Effect.forEach(calls, (call) => runCall(toolkit, call), { concurrency: "unbounded" }),
          (all) => {
            const results = all.flat()

            return Stream.fromIterable(results.map((result) => Loop.value(result.event))).pipe(
              Stream.concat(then(results.some((result) => result.failed)))
            )
          }
        )
      )
    )
  )

/**
 * One step of the agent loop, as a body for effect-uai's `Loop.loop`: it
 * calls the model with the current history and emits its `ModelOutput`,
 * then runs the output's tool calls and emits a `ToolStarted` and a
 * `ToolResult` for each. `then` decides what comes next: `Loop.next(state)`
 * or `Loop.stop()`.
 *
 * **Details**
 *
 * A step whose history has calls a crash cut off runs those first, with the
 * same ids, and doesn't call the model. Whoever consumes the loop records each event
 * before pulling the next, so the next step's history has it; `then` runs
 * after the step's events are recorded.
 *
 * **Example** (A loop of your own)
 *
 * ```ts
 * import * as Loop from "@effect-uai/core/Loop"
 * import { AssistantLoop } from "effect-assistant"
 *
 * const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
 *   Loop.loop({ steps: 0 }, (state) =>
 *     AssistantLoop.step(
 *       { model: "claude-sonnet-5", instructions: turn.instructions("You help a small team."), toolkit: turn.tools, history: turn.history(), toolChoice: "required" },
 *       (result) => result.done || state.steps >= 12 ? Loop.stop() : Loop.next({ steps: state.steps + 1 })
 *     )
 *   )
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const step = <Tools extends Toolkit.Toolkit, S, E2 = never, R2 = never>(
  options: StepOptions<Tools>,
  then: (result: StepResult) => Stream.Stream<Loop.Step<never, S>, E2, R2>
): Stream.Stream<
  Loop.Step<Event, S>,
  AiError.AiError | ToolErrors<Tools> | E2,
  LanguageModel.LanguageModel | ToolServices<Tools> | R2
> => {
  const { toolkit } = options
  const instructions = Predicate.isString(options.instructions) ? { text: options.instructions } : options.instructions

  const next = (result: StepResult) => Stream.unwrap(Effect.sync(() => then(result)))

  return Stream.unwrap(
    Effect.gen(function* () {
      const history = yield* options.history
      // Calls a crash cut off, with no result: they run again, with the same ids, before the model goes on.
      const cutOff = HistoryCheck.findUnansweredCalls(history)

      if (cutOff.length > 0) {
        return runCalls(toolkit, cutOff, () =>
          next({ output: undefined, done: false, historyLength: history.length + cutOff.length })
        )
      }

      const input = [Items.systemText(instructions.text), ...history]

      const turn = yield* LanguageModel.turn({
        model: options.model,
        history: input,
        tools: toolkit,
        toolChoice: options.toolChoice
      }).pipe(Telemetry.chatSpan(options.model, input, instructions.attributes))

      const output = AssistantEvent.ModelOutput.make({ items: turn.items.map(withJsonArguments) })
      const calls = Turn.getToolCalls(turn)
      const historyLength = history.length + turn.items.length + calls.length

      // A failed call doesn't end the turn: a message that failed never reached the user, so the model reads why.
      return Stream.make(Loop.value(output)).pipe(
        Stream.concat(
          runCalls(toolkit, calls, (failed) =>
            next({
              output,
              done: calls.length === 0 || (!failed && calls.some(endsTurn)),
              historyLength
            })
          )
        )
      )
    })
  )
}

/**
 * Runs the agent loop as a stream: {@link step} after step, until the model
 * is done (see {@link StepResult}) and nothing new arrived while it worked,
 * or after `maxSteps` model calls.
 *
 * **Details**
 *
 * Each tool call is stored as started before it runs, and a call a crash cut
 * off (in the history with no result) runs again, with the same call id,
 * before the next model call. So a tool call runs at least once: a tool
 * that changes something outside the chat uses
 * `AssistantToolCall.idempotencyKey`.
 * The tools run only once the output is pulled, and the next model call only
 * once the results are: whoever consumes the stream records each event before
 * the next step reads the history.
 *
 * @category constructors
 * @since 0.1.0
 */
export const stream = <Tools extends Toolkit.Toolkit>(
  options: Options<Tools>
): Stream.Stream<Event, AiError.AiError | ToolErrors<Tools>, LanguageModel.LanguageModel | ToolServices<Tools>> => {
  const maxSteps = options.maxSteps ?? 16

  // Done: stop, unless something arrived while the model was working; then it reads that first.
  const afterDone = (steps: number, historyLength: number) =>
    Stream.unwrap(
      Effect.map(options.history, (history) =>
        history.length > historyLength ? Loop.next(steps) : Loop.stop<number>()
      )
    )

  return Loop.loop(0, (steps: number) =>
    step(options, (result) => {
      const taken = result.output === undefined ? steps : steps + 1

      if (taken >= maxSteps) return Loop.stop<number>()

      return result.done ? afterDone(taken, result.historyLength) : Loop.next(taken)
    })
  )
}
