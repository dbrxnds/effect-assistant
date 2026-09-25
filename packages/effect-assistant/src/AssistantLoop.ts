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
 *     instructions: `${turn.preamble}\n\n${instructions}`,
 *     toolkit: { ...turn.tools, ...toolkit },
 *     history: turn.history,
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
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as ToolResultWire from "@effect-uai/core/ToolResult"
import * as Turn from "@effect-uai/core/Turn"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import * as AssistantEvent from "./AssistantEvent.ts"
import { AssistantToolCall, isDestructive } from "./AssistantToolCall.ts"
import type * as Instructions from "./Instructions.ts"
import { mayHaveRunOutput } from "./internal/history.ts"
import * as Telemetry from "./internal/telemetry.ts"
import { waitToolName } from "./internal/tools.ts"

/**
 * What the loop produces: each model call's output, then for each of its tool
 * calls a `ToolStarted` before it runs and its result.
 *
 * @category models
 * @since 0.1.0
 */
export type Event = AssistantEvent.ModelOutput | AssistantEvent.ToolStarted | AssistantEvent.ToolResult

/**
 * Options for {@link stream}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options<Tools extends Toolkit.Toolkit = Toolkit.Toolkit> {
  /** The model to call, as the `LanguageModel` in context names it (e.g. `"claude-sonnet-5"`). */
  readonly model: string
  /** The full system prompt, optionally with span attributes (like the prompt's name and version). */
  readonly instructions: string | Instructions.Resolved
  readonly toolkit?: Tools | undefined
  /** The current history. Read before every model call. */
  readonly history: Effect.Effect<ReadonlyArray<Items.HistoryItem>>
  /** Model calls allowed. Default 16. */
  readonly maxSteps?: number | undefined
  /** `"required"` makes every step a tool call: assistants talk only through tools. */
  readonly toolChoice?: LanguageModel.CommonRequest["toolChoice"] | undefined
}

/**
 * A tool call with no input can arrive with `arguments: ""`. Store `"{}"`
 * instead: the Anthropic adapter parses arguments when it sends history back,
 * and `""` isn't JSON.
 */
const withJsonArguments = (item: Items.HistoryItem): Items.HistoryItem =>
  Items.isToolCall(item) && item.arguments.trim() === "" ? { ...item, arguments: "{}" } : item

/** Runs one call through the toolkit, in its own span, with the call as `AssistantToolCall`. */
const runCall = (toolkit: Toolkit.Toolkit, call: Items.ToolCall) =>
  Toolkit.collectResults(Toolkit.run(toolkit, [call])).pipe(
    Effect.provideService(AssistantToolCall, { callId: call.call_id, tool: call.name }),
    Effect.map((results) =>
      results.map((result) => {
        const wire = ToolResultWire.toToolCallOutput(result)

        return AssistantEvent.ToolResult.make({ callId: wire.call_id, tool: call.name, output: wire.output })
      })
    ),
    Effect.tap((results) => Telemetry.toolOutput(results.map((result) => result.output).join("\n"))),
    Telemetry.toolSpan(call)
  )

/** The loop's state between model calls. */
interface State {
  readonly steps: number
  /** After a step that stopped: the history length if nothing new arrives. */
  readonly doneAt: number | undefined
}

/**
 * Runs the agent loop as a stream, on effect-uai's `Loop`: each iteration
 * calls the model with the current history and emits its `ModelOutput`, then
 * runs that output's tool calls concurrently and emits their `ToolResult`s.
 *
 * **Details**
 *
 * It ends when the model is done (it made no tool calls, or called `wait`)
 * and nothing new arrived while it worked, or after `maxSteps` model calls.
 *
 * Each tool call is stored as started before it runs, and a call a crash cut
 * off (in the history with no result) runs again, with the same call id,
 * before the next model call, unless its tool is marked
 * `AssistantToolCall.destructive`. So a tool call runs at least once: a tool
 * that changes something outside the chat uses
 * `AssistantToolCall.idempotencyKey`, or is marked destructive.
 * The tools run only once the output is pulled, and the next model call only
 * once the results are: whoever consumes the stream records each event before
 * the next step reads the history.
 *
 * @category constructors
 * @since 0.1.0
 */
export const stream = <Tools extends Toolkit.Toolkit = Record<never, never>>(
  options: Options<Tools>
): Stream.Stream<
  Event,
  AiError.AiError,
  LanguageModel.LanguageModel | Exclude<Toolkit.ToolkitR<Tools>, AssistantToolCall>
> => {
  const toolkit: Toolkit.Toolkit = options.toolkit ?? {}
  const maxSteps = options.maxSteps ?? 16

  const instructions = Predicate.isString(options.instructions) ? { text: options.instructions } : options.instructions

  /** Runs the calls: first a `ToolStarted` for each (stored before any runs), then their results. */
  const runCalls = (calls: ReadonlyArray<Items.ToolCall>, then: (results: number) => State) =>
    Stream.fromIterable(
      calls.map((call) => Loop.value(AssistantEvent.ToolStarted.make({ callId: call.call_id, tool: call.name })))
    ).pipe(
      Stream.concat(
        Stream.unwrap(
          Effect.forEach(calls, (call) => runCall(toolkit, call), { concurrency: "unbounded" }).pipe(
            Effect.map((all) => {
              const results = all.flat()

              return Stream.fromIterable(results.map(Loop.value)).pipe(Stream.concat(Loop.next(then(results.length))))
            })
          )
        )
      )
    )

  const runTools = (calls: ReadonlyArray<Items.ToolCall>, state: State, seen: number) =>
    runCalls(calls, (results) => ({
      steps: state.steps + 1,
      doneAt: calls.some((call) => call.name === waitToolName) ? seen + results : undefined
    }))

  const step = Effect.fn(function* (state: State) {
    const history = yield* options.history
    // Calls a crash cut off, with no result: they run again, with the same ids, before the model goes on.
    // A destructive tool's call doesn't: the model is told it may have run.
    const cutOff = HistoryCheck.findUnansweredCalls(history)

    if (cutOff.length > 0) {
      const destructive = cutOff.filter((call) => isDestructive(toolkit[call.name]))
      const again = cutOff.filter((call) => !isDestructive(toolkit[call.name]))

      return Stream.fromIterable(
        destructive.map((call) =>
          Loop.value(
            AssistantEvent.ToolResult.make({ callId: call.call_id, tool: call.name, output: mayHaveRunOutput })
          )
        )
      ).pipe(Stream.concat(again.length > 0 ? runCalls(again, () => state) : Loop.next(state)))
    }

    // Done, unless something arrived while the model was working.
    if (state.doneAt !== undefined && history.length === state.doneAt) return Loop.stop()

    if (state.steps >= maxSteps) return Loop.stop()

    const input = [Items.systemText(instructions.text), ...history]

    const turn = yield* LanguageModel.turn({
      model: options.model,
      history: input,
      tools: toolkit,
      toolChoice: options.toolChoice
    }).pipe(Telemetry.chatSpan(options.model, input, instructions.attributes))

    const output = Loop.value(AssistantEvent.ModelOutput.make({ items: turn.items.map(withJsonArguments) }))
    const calls = Turn.getToolCalls(turn)
    const seen = history.length + turn.items.length

    return calls.length === 0
      ? Stream.make(output).pipe(Stream.concat(Loop.next<State>({ steps: state.steps + 1, doneAt: seen })))
      : Stream.make(output).pipe(Stream.concat(runTools(calls, state, seen)))
  })

  // SAFETY: running a call needs exactly the tools' own requirements.
  return Loop.loop<State, Event, AiError.AiError, LanguageModel.LanguageModel>(
    { steps: 0, doneAt: undefined },
    step
  ) as Stream.Stream<
    Event,
    AiError.AiError,
    LanguageModel.LanguageModel | Exclude<Toolkit.ToolkitR<Tools>, AssistantToolCall>
  >
}

/**
 * Options for {@link step}.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepOptions<Tools extends Toolkit.Toolkit = Toolkit.Toolkit> {
  /** The model to call, as the `LanguageModel` in context names it. */
  readonly model: string
  /** The full system prompt, like `turn.instructions(text)`. */
  readonly instructions: string | Instructions.Resolved
  readonly toolkit?: Tools | undefined
  /** The current history, read at the start of the step. */
  readonly history: Effect.Effect<ReadonlyArray<Items.HistoryItem>>
  readonly toolChoice?: LanguageModel.CommonRequest["toolChoice"] | undefined
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
  /** Whether the model is done: it made no tool calls, or called `wait`. */
  readonly done: boolean
}

/** A tool call's results as loop values: its start, then its results. */
const callValues = (toolkit: Toolkit.Toolkit, calls: ReadonlyArray<Items.ToolCall>) =>
  Stream.fromIterable(
    calls.map((call) => Loop.value(AssistantEvent.ToolStarted.make({ callId: call.call_id, tool: call.name })))
  ).pipe(
    Stream.concat(
      Stream.unwrap(
        Effect.forEach(calls, (call) => runCall(toolkit, call), { concurrency: "unbounded" }).pipe(
          Effect.map((all) => Stream.fromIterable(all.flat().map(Loop.value)))
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
 * same ids (a destructive tool's call gets a may-have-run result instead),
 * and doesn't call the model. As with {@link stream}, whoever consumes the
 * loop records each event before pulling the next.
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
 *       { model: "claude-sonnet-5", instructions: turn.instructions("You help a small team."), toolkit: turn.tools, history: turn.history, toolChoice: "required" },
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
  AiError.AiError | E2,
  LanguageModel.LanguageModel | Exclude<Toolkit.ToolkitR<Tools>, AssistantToolCall> | R2
> => {
  const toolkit: Toolkit.Toolkit = options.toolkit ?? {}

  const instructions = Predicate.isString(options.instructions) ? { text: options.instructions } : options.instructions

  const body = Effect.gen(function* () {
    const history = yield* options.history
    const cutOff = HistoryCheck.findUnansweredCalls(history)

    if (cutOff.length > 0) {
      const destructive = cutOff.filter((call) => isDestructive(toolkit[call.name]))
      const again = cutOff.filter((call) => !isDestructive(toolkit[call.name]))

      return Stream.fromIterable(
        destructive.map((call) =>
          Loop.value(
            AssistantEvent.ToolResult.make({ callId: call.call_id, tool: call.name, output: mayHaveRunOutput })
          )
        )
      ).pipe(
        Stream.concat(callValues(toolkit, again)),
        Stream.concat(Stream.unwrap(Effect.sync(() => then({ output: undefined, done: false }))))
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
    const done = calls.length === 0 || calls.some((call) => call.name === waitToolName)

    return Stream.make(Loop.value(output)).pipe(
      Stream.concat(callValues(toolkit, calls)),
      Stream.concat(Stream.unwrap(Effect.sync(() => then({ output, done }))))
    )
  })

  // SAFETY: running a call needs exactly the tools' own requirements.
  return Stream.unwrap(body) as Stream.Stream<
    Loop.Step<Event, S>,
    AiError.AiError | E2,
    LanguageModel.LanguageModel | Exclude<Toolkit.ToolkitR<Tools>, AssistantToolCall> | R2
  >
}
