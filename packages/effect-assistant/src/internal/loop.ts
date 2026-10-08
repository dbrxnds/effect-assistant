/**
 * The agent loop: call the model, run its tool calls, repeat. `AssistantLoop`
 * is its public face, with native toolkits; turns and specialist runs use it
 * here, with their tools already merged.
 */
import type * as AiError from "effect/ai/AiError"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as AssistantEvent from "../AssistantEvent.ts"
import * as DecisionId from "../DecisionId.ts"
import type * as Instructions from "../Instructions.ts"
import * as Decisions from "./decisions.ts"
import * as History from "./history.ts"
import * as Telemetry from "./telemetry.ts"
import * as Toolkits from "./toolkit.ts"
import { isTurnEnding } from "./tools.ts"

/**
 * What the loop produces: each model call's output, then for each of its tool
 * calls a `ToolStarted` before it runs and its result, or, for a call that
 * waits for the user's decision, its `DecisionRequested`.
 */
export type Event =
  | AssistantEvent.ModelOutput
  | AssistantEvent.ToolStarted
  | AssistantEvent.ToolResult
  | AssistantEvent.DecisionRequested

/**
 * The assistant's own tools (`send_user_message`, `wait`, the specialist
 * tools), with the turn's services: a turn provides them, so a loop of the
 * app's own in it can message the user. A specialist's run has none.
 */
export const TurnTools = Context.Reference<Option.Option<Toolkits.Tools>>("effect-assistant/TurnTools", {
  defaultValue: Option.none
})

/**
 * A chat's history as the model reads it: its messages, and the last `seq`
 * of the chat they cover.
 */
export interface ChatHistory {
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly throughSeq: number
}

/** The messages of a history, and how far into the chat they go, if they're a chat's. */
const readHistory = (read: ReadonlyArray<Prompt.Message> | ChatHistory) =>
  "messages" in read
    ? { messages: read.messages, throughSeq: read.throughSeq }
    : { messages: read, throughSeq: undefined }

/** Options for {@link step}. */
export interface StepOptions<R = never> {
  /** The full system prompt, like `turn.instructions(text)`, optionally with span attributes. */
  readonly instructions: string | Instructions.Resolved
  /** The tools the model can call. Default: none. */
  readonly toolkit?: Toolkits.Tools<R> | undefined
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
export interface Options<R = never> extends StepOptions<R> {
  /** Model calls allowed. Default 16. */
  readonly maxSteps?: number | undefined
}

/** How a step went, for deciding what comes next. */
export interface StepResult {
  /** The model's output; unset when the step only ran calls a crash cut off. */
  readonly output: AssistantEvent.ModelOutput | undefined
  /**
   * Whether the model is done: it made no tool calls, or ended its turn (`wait`, or a message
   * with `wait: true`) and none of the step's calls failed.
   */
  readonly done: boolean
  /**
   * The history's length with this step's output and results: a longer one got something new meanwhile.
   */
  readonly historyLength: number
}

/**
 * What a model call is given: the tools' definitions. The loop runs the calls itself, after storing each as started,
 * so the model call runs none.
 */
const requestToolkit = (definitions: ReadonlyArray<Tool.Any>): Toolkit.WithHandler<Record<string, Tool.Any>> => ({
  // The loop decides which calls wait for the user's decision; the model call would ask for approvals of its own.
  tools: Object.fromEntries(
    definitions.map((tool) => [tool.name, tool.needsApproval === undefined ? tool : tool.setNeedsApproval(false)])
  ),
  handle: () => Effect.succeed(Stream.empty)
})

/**
 * One model call. Tool call resolution stays on with a toolkit that runs nothing: with it off, a call whose params
 * don't fit its tool's schema fails the whole model call, and here the model reads why instead.
 */
const generate = (
  prompt: Prompt.Prompt,
  definitions: ReadonlyArray<Tool.Any>,
  toolChoice: LanguageModel.ToolChoice<string> | undefined
): Effect.Effect<
  LanguageModel.GenerateTextResponse<Record<string, Tool.Any>, "opaque">,
  AiError.AiError,
  LanguageModel.LanguageModel
> => LanguageModel.generateText({ prompt, toolkit: requestToolkit(definitions), toolChoice })

const decodePart = Schema.decodeUnknownOption(AssistantEvent.ModelPart)

/**
 * The parts the log keeps: text, reasoning, and the calls the loop runs (not those the provider ran).
 */
const modelParts = (content: ReadonlyArray<Response.AllParts<Record<string, Tool.Any>>>) =>
  content.flatMap((part) =>
    Option.toArray(decodePart(part)).filter((decoded) => !(decoded.type === "tool-call" && decoded.providerExecuted))
  )

const toolCalls = (parts: ReadonlyArray<AssistantEvent.ModelPart>): ReadonlyArray<AssistantEvent.ToolCallPart> =>
  parts.flatMap((part) => (part.type === "tool-call" ? [part] : []))

/** Runs one call, in its own span. */
const runCall = Effect.fnUntraced(function* <R>(tools: Toolkits.Tools<R>, call: AssistantEvent.ToolCallPart) {
  const result = yield* Effect.gen(function* () {
    const result = yield* tools.run(call)

    yield* Telemetry.toolOutput(result.result)

    return result
  }).pipe(Telemetry.toolSpan(call))

  return AssistantEvent.ToolResult.make({ callId: call.id, tool: call.name, ...result })
})

/** A call to run: `approved` when the user approved it, so it runs without asking again. */
interface Pending {
  readonly call: AssistantEvent.ToolCallPart
  readonly approved: boolean
}

/**
 * Parks a call that needs the user's decision: its `DecisionRequested`. Only a turn parks: a specialist's call fails
 * instead.
 */
const park = Effect.fnUntraced(
  function* (call: AssistantEvent.ToolCallPart) {
    if (Option.isNone(yield* Decisions.TurnDecisions)) {
      return AssistantEvent.ToolResult.make({
        callId: call.id,
        tool: call.name,
        ...Toolkits.failed(
          `${call.name} needs the user's decision, and only the assistant can ask them. Don't run it: say in your answer what needs deciding, with the details.`,
          "needs_decision"
        )
      })
    }

    return AssistantEvent.DecisionRequested.make({
      id: DecisionId.fromCallId(call.id),
      origin: AssistantEvent.CallOrigin.make({ callId: call.id, tool: call.name, params: call.params })
    })
  },
  (effect, call) => effect.pipe(Telemetry.toolSpan(call))
)

/**
 * Runs the calls: first a `ToolStarted` for each that runs (stored before any runs), then their results
 * concurrently, with a `DecisionRequested` for each that waits for the user's decision instead, then `then`, told
 * whether the model has to read them: one failed, or waits.
 */
const runCalls = <R, S, E, R2>(
  tools: Toolkits.Tools<R>,
  pending: ReadonlyArray<Pending>,
  history: ReadonlyArray<Prompt.Message>,
  then: (reread: boolean) => Stream.Stream<Step<never, S>, E, R2>
): Stream.Stream<Step<Event, S>, E, R | R2> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const parks = yield* Effect.forEach(pending, ({ call, approved }) =>
        approved ? Effect.succeed(false) : Toolkits.needsDecisionOf(tools, call, history)
      )

      const started = pending.flatMap(({ call }, i) =>
        parks[i] ? [] : [value(AssistantEvent.ToolStarted.make({ callId: call.id, tool: call.name }))]
      )

      const results = Effect.forEach(pending, ({ call }, i) => (parks[i] ? park(call) : runCall(tools, call)), {
        concurrency: "unbounded"
      })

      const reread = (done: ReadonlyArray<Event>) =>
        done.some((event) => Predicate.isTagged(event, "DecisionRequested") || isFailure(event))

      return Stream.fromIterable(started).pipe(
        Stream.concat(
          Stream.unwrap(
            Effect.gen(function* () {
              const done = yield* results

              return Stream.fromIterable(done.map(value)).pipe(Stream.concat(then(reread(done))))
            })
          )
        )
      )
    })
  )

const isFailure = (event: Event) => Predicate.isTagged(event, "ToolResult") && event.outcome === "failure"

/** What a loop body emits: a value, or what to do next. */
export type Step<A, S> = Data.TaggedEnum<{
  Value: { readonly value: A }
  Next: { readonly state: S }
  Stop: Record<never, never>
}>

interface StepDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: Step<this["A"], this["B"]>
}

const Steps = Data.taggedEnum<StepDefinition>()

/** Emits a value from a loop body. */
export const value = <A>(value: A): Step<A, never> => Steps.Value({ value })

/** Ends a loop body's step and goes on with this state. */
export const next = <S>(state: S): Stream.Stream<Step<never, S>> => Stream.succeed(Steps.Next({ state }))

/** Ends the loop. */
// oxlint-disable-next-line no-unnecessary-type-parameters -- `stop<number>()` types a loop's state where inference can't.
export const stop = <S = never>(): Stream.Stream<Step<never, S>> => Stream.succeed(Steps.Stop())

const isValue = <A, S>(step: Step<A, S>): step is Data.TaggedEnum.Value<Step<A, S>, "Value"> =>
  Predicate.isTagged(step, "Value")

/**
 * Runs a loop body from a state: emits its values, and runs it again with the
 * state it goes `next` with, until it `stop`s. A body that ends without
 * either stops too.
 */
export const loop = <S, A, E, R>(
  initial: S,
  body: (state: S) => Stream.Stream<Step<A, S>, E, R>
): Stream.Stream<A, E, R> => {
  const go = (state: S): Stream.Stream<A, E, R> =>
    Stream.suspend(() => {
      let after: Option.Option<S> = Option.none()

      return body(state).pipe(
        Stream.tap((step) =>
          Effect.sync(() => (after = Predicate.isTagged(step, "Next") ? Option.some(step.state) : after))
        ),
        Stream.filter(isValue),
        Stream.map((step) => step.value),
        Stream.concat(Stream.suspend(() => Option.match(after, { onNone: () => Stream.empty, onSome: go })))
      )
    })

  return go(initial)
}

/**
 * One step of the agent loop, as a body for {@link loop}: it calls the model
 * with the current history and emits its `ModelOutput`, then runs the
 * output's tool calls and emits a `ToolStarted` and a `ToolResult` for each,
 * or a `DecisionRequested` for one that waits for the user's decision.
 * `then` decides what comes next: `AssistantLoop.next(state)` or
 * `AssistantLoop.stop()`.
 */
export const step = <R, S, E2 = never, R2 = never>(
  options: StepOptions<R>,
  then: (result: StepResult) => Stream.Stream<Step<never, S>, E2, R2>
): Stream.Stream<Step<Event, S>, AiError.AiError | E2, LanguageModel.LanguageModel | R | R2> => {
  const toolkit = options.toolkit ?? Toolkits.empty
  const instructions = Predicate.isString(options.instructions) ? { text: options.instructions } : options.instructions

  const after = (result: StepResult) => Stream.suspend(() => then(result))

  return Stream.unwrap(
    Effect.gen(function* () {
      const { messages: history, throughSeq } = readHistory(yield* options.history)
      // Calls a crash cut off, with no result: they run again, with the same ids, before the model goes on.
      const cutOff = History.unansweredCalls(history)

      // Calls the user approved: they run as the model made them, before the model goes on. Not in a loop without them.
      const decisions = yield* Decisions.TurnDecisions

      const approved = Option.isNone(decisions)
        ? []
        : (yield* decisions.value.approved).filter((call) =>
            toolkit.definitions.some((tool) => tool.name === call.name)
          )

      if (cutOff.length > 0 || approved.length > 0) {
        const pending = [
          ...cutOff.map((call) => ({ call, approved: false })),
          ...approved.map((call) => ({ call, approved: true }))
        ]

        return runCalls(toolkit, pending, history, () =>
          after({ output: undefined, done: false, historyLength: history.length + pending.length })
        )
      }

      const prompt = Prompt.fromMessages([Prompt.systemMessage({ content: instructions.text }), ...history])
      const name = yield* Effect.serviceOption(Model.ModelName)
      const started = yield* Clock.currentTimeMillis

      const response = yield* generate(prompt, toolkit.definitions, options.toolChoice).pipe(
        Telemetry.chatSpan(prompt, instructions.attributes)
      )

      const metadata = response.content.find((part) => part.type === "response-metadata")

      const output = AssistantEvent.ModelOutput.make({
        parts: modelParts(response.content),
        seenThroughSeq: throughSeq,
        model: metadata?.modelId ?? Option.getOrUndefined(name),
        responseId: metadata?.id,
        usage: response.usage,
        durationMillis: (yield* Clock.currentTimeMillis) - started
      })

      const calls = toolCalls(output.parts)
      const historyLength = history.length + Prompt.fromResponseParts(output.parts).content.length + calls.length

      // A failed call doesn't end the turn: a message that failed never reached the user, so the model reads why. Nor
      // does a parked one: the model asks the user for the decision it waits for.
      return Stream.make(value(output)).pipe(
        Stream.concat(
          runCalls(
            toolkit,
            calls.map((call) => ({ call, approved: false })),
            history,
            (reread) =>
              after({
                output,
                done: calls.length === 0 || (!reread && calls.some(isTurnEnding)),
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
 */
export const run = <R = never>(
  options: Options<R>
): Stream.Stream<Event, AiError.AiError, LanguageModel.LanguageModel | R> => {
  const maxSteps = options.maxSteps ?? 16

  // Done: stop, unless something arrived while the model was working; then it reads that first.
  const afterDone = (steps: number, historyLength: number) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const read = yield* options.history

        return readHistory(read).messages.length > historyLength ? next(steps) : stop<number>()
      })
    )

  return loop(0, (steps: number) =>
    step(options, (result) => {
      const taken = result.output === undefined ? steps : steps + 1

      if (taken >= maxSteps) return stop<number>()

      return result.done ? afterDone(taken, result.historyLength) : next(taken)
    })
  )
}
