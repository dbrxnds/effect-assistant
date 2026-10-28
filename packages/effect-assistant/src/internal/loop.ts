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
import type * as Instructions from "../Instructions.ts"
import * as History from "./history.ts"
import * as Telemetry from "./telemetry.ts"
import * as Toolkits from "./toolkit.ts"
import { isTurnEnding, isUserMessage } from "./tools.ts"

/** @internal */
export type Event =
  | AssistantEvent.ModelOutput
  | AssistantEvent.ToolStarted
  | AssistantEvent.ToolResult
  | AssistantEvent.ApprovalRequested

// Only a turn's loop can wait for the user's approval, and runs the calls they approved. A turn's specialists inherit
// its context, so their runs set it back to none.
/** @internal */
export const TurnApprovals = Context.Reference<
  Option.Option<{ readonly approved: Effect.Effect<ReadonlyArray<AssistantEvent.ToolCallPart>> }>
>("effect-assistant/TurnApprovals", { defaultValue: Option.none })

// The assistant's own tools with the turn's services, so an app's own loop in a turn can message the user. A
// specialist's run has none.
/** @internal */
export const TurnTools = Context.Reference<Option.Option<Toolkits.Tools>>("effect-assistant/TurnTools", {
  defaultValue: Option.none
})

/** @internal */
export interface ChatHistory {
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly throughSequence: number
}

const readHistory = (read: ReadonlyArray<Prompt.Message> | ChatHistory) =>
  "messages" in read
    ? { messages: read.messages, throughSequence: read.throughSequence }
    : { messages: read, throughSequence: undefined }

// `AssistantLoop` takes native toolkits; turns and specialist runs come here with their tools already merged.
/** @internal */
export interface StepOptions<R = never> {
  readonly instructions: string | Instructions.Resolved
  readonly toolkit?: Toolkits.Tools<R> | undefined
  readonly history: Effect.Effect<ReadonlyArray<Prompt.Message> | ChatHistory>
  readonly toolChoice?: LanguageModel.ToolChoice<string> | undefined
}

/** @internal */
export interface Options<R = never> extends StepOptions<R> {
  readonly maxSteps?: number | undefined
}

// Its member docs show through `AssistantLoop.StepResult`.
/** @internal */
export interface StepResult {
  /** The model's output; unset when the step only ran calls a crash cut off. */
  readonly output: AssistantEvent.ModelOutput | undefined
  /**
   * Whether the model is done: it made no tool calls, one of its calls waits for the user's
   * approval, or it ended its turn (`wait`, or a message with `wait: true`) and none of the step's
   * calls failed.
   */
  readonly done: boolean
  /**
   * The history's length with this step's output and results: a longer one got something new meanwhile.
   */
  readonly historyLength: number
}

// A tool as `Tool.isUserDefined` narrows one. With `Tool.Any`, generateText's types ask for the services that encode
// every tool's params, `unknown` for a schema of unknown type, though deferred validation encodes none.
type RequestTool = Tool.Tool<string, any, any>

// The loop runs the calls itself, after storing each as started, so the model call runs none. It also decides which
// calls wait for approval: the model call would ask for approvals of its own.
const requestToolkit = (definitions: ReadonlyArray<Tool.Any>): Toolkit.WithHandler<Record<string, RequestTool>> => ({
  tools: Object.fromEntries(
    definitions.map((tool) => [
      tool.name,
      tool.needsApproval === undefined || tool.needsApproval === false ? tool : tool.setNeedsApproval(false)
    ])
  ),
  handle: () => Effect.succeed(Stream.empty)
})

// Validation is deferred: a call to a tool that isn't in the toolkit (one in the history the turn no longer offers),
// or with params that don't fit its schema, would otherwise fail the whole model call. The loop runs it instead, and
// the model reads why it failed.
const generate = (
  prompt: Prompt.Prompt,
  definitions: ReadonlyArray<Tool.Any>,
  toolChoice: LanguageModel.ToolChoice<string> | undefined
): Effect.Effect<
  LanguageModel.GenerateTextResponse<Record<string, RequestTool>, "deferred">,
  AiError.AiError,
  LanguageModel.LanguageModel
> =>
  LanguageModel.generateText({
    prompt,
    toolkit: requestToolkit(definitions),
    toolChoice,
    disableToolCallResolution: true,
    toolCallValidation: "deferred"
  })

const decodePart = Schema.decodeUnknownOption(AssistantEvent.ModelPart)

const modelParts = (content: ReadonlyArray<Response.AllParts<Record<string, Tool.Any>>>) =>
  content.flatMap((part) =>
    Option.toArray(decodePart(part)).filter((decoded) => !(decoded.type === "tool-call" && decoded.providerExecuted))
  )

const toolCalls = (parts: ReadonlyArray<AssistantEvent.ModelPart>): ReadonlyArray<AssistantEvent.ToolCallPart> =>
  parts.flatMap((part) => (part.type === "tool-call" ? [part] : []))

const runCall = Effect.fnUntraced(function* <R>(tools: Toolkits.Tools<R>, call: AssistantEvent.ToolCallPart) {
  const result = yield* Effect.gen(function* () {
    const result = yield* tools.run(call)

    yield* Telemetry.toolOutput(result.result)

    return result
  }).pipe(Telemetry.toolSpan(call))

  return AssistantEvent.ToolResult.make({ callId: call.id, tool: call.name, ...result })
})

// A call that needs approval waits for the user in a turn. A specialist's run can't ask them, so its call fails.
const awaitApproval = Effect.fnUntraced(function* (call: AssistantEvent.ToolCallPart) {
  if (Option.isNone(yield* TurnApprovals)) {
    return AssistantEvent.ToolResult.make({
      callId: call.id,
      tool: call.name,
      ...Toolkits.failed(
        `${call.name} needs the user's approval, and only the assistant can ask for it. Don't run it: say in your answer what needs approving, with the details.`,
        "NeedsApproval"
      )
    })
  }

  return AssistantEvent.ApprovalRequested.make({ callId: call.id, tool: call.name, params: call.params })
})

interface Pending {
  readonly call: AssistantEvent.ToolCallPart
  /** The user approved it: it runs without asking again. */
  readonly approved: boolean
}

interface Ran {
  /** One of the calls failed, so the model has to read the results. */
  readonly failed: boolean
  /** One of the calls waits for the user's approval, so the turn ends. */
  readonly waiting: boolean
}

// The approval shows the call, not what it does: the user learns that from the assistant's message beside it.
const unexplained = (call: AssistantEvent.ToolCallPart) =>
  AssistantEvent.ToolResult.make({
    callId: call.id,
    tool: call.name,
    ...Toolkits.failed(
      `Not sent for approval: the user would see buttons without knowing what they approve. In one step, send them a message with send_user_message saying what ${call.name} will do (what, to whom, how many), and call ${call.name} again.`,
      "ApprovalNeedsMessage"
    )
  })

// Every `ToolStarted` is stored before any call runs; a call that waits for approval doesn't start.
const runCalls = <R, S, E, R2>(
  tools: Toolkits.Tools<R>,
  pending: ReadonlyArray<Pending>,
  history: ReadonlyArray<Prompt.Message>,
  then: (ran: Ran) => Stream.Stream<Step<never, S>, E, R2>
): Stream.Stream<Step<Event, S>, E, R | R2> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const waits = yield* Effect.forEach(pending, ({ call, approved }) =>
        approved ? Effect.succeed(false) : tools.needsApproval(call, history)
      )

      const started = pending.flatMap(({ call }, i) =>
        waits[i] === true ? [] : [value(AssistantEvent.ToolStarted.make({ callId: call.id, tool: call.name }))]
      )

      return Stream.fromIterable(started).pipe(
        Stream.concat(
          Stream.unwrap(
            Effect.gen(function* () {
              const explained = pending.some(({ call }) => isUserMessage(call))

              const done = yield* Effect.forEach(
                pending,
                ({ call }, i): Effect.Effect<Event, never, R> =>
                  waits[i] !== true
                    ? runCall(tools, call)
                    : explained
                      ? awaitApproval(call)
                      : Effect.succeed(unexplained(call)),
                { concurrency: "unbounded" }
              )

              return Stream.fromIterable(done.map(value)).pipe(
                Stream.concat(
                  then({
                    failed: done.some(isFailure),
                    waiting: done.some((event) => Predicate.isTagged(event, "ApprovalRequested"))
                  })
                )
              )
            })
          )
        )
      )
    })
  )

const isFailure = (event: Event) => Predicate.isTagged(event, "ToolResult") && event.outcome === "failure"

/** @internal */
export type Step<A, S> = Data.TaggedEnum<{
  Value: { readonly value: A }
  Next: { readonly state: S }
  Stop: Record<never, never>
}>

interface StepDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: Step<this["A"], this["B"]>
}

const Steps = Data.taggedEnum<StepDefinition>()

/** @internal */
export const value = <A>(value: A): Step<A, never> => Steps.Value({ value })

/** @internal */
export const next = <S>(state: S): Stream.Stream<Step<never, S>> => Stream.succeed(Steps.Next({ state }))

/** @internal */
// oxlint-disable-next-line no-unnecessary-type-parameters -- `stop<number>()` types a loop's state where inference can't.
export const stop = <S = never>(): Stream.Stream<Step<never, S>> => Stream.succeed(Steps.Stop())

const isValue = <A, S>(step: Step<A, S>): step is Data.TaggedEnum.Value<Step<A, S>, "Value"> =>
  Predicate.isTagged(step, "Value")

// A body that ends without `next` or `stop` stops too.
/** @internal */
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

/** @internal */
export const step = <R, S, E2 = never, R2 = never>(
  options: StepOptions<R>,
  then: (result: StepResult) => Stream.Stream<Step<never, S>, E2, R2>
): Stream.Stream<Step<Event, S>, AiError.AiError | E2, LanguageModel.LanguageModel | R | R2> => {
  const toolkit = options.toolkit ?? Toolkits.empty
  const instructions = Predicate.isString(options.instructions) ? { text: options.instructions } : options.instructions

  const after = (result: StepResult) => Stream.suspend(() => then(result))

  return Stream.unwrap(
    Effect.gen(function* () {
      const { messages: history, throughSequence } = readHistory(yield* options.history)
      // Calls a crash cut off, with no result: they run again, with the same ids, before the model goes on.
      const cutOff = History.unansweredCalls(history)
      const approvals = yield* TurnApprovals

      // Calls the user approved: they run as the model made them, with the same ids, before the model goes on. Not in
      // a loop without their tools.
      const approved = Option.isNone(approvals)
        ? []
        : (yield* approvals.value.approved).filter(
            (call) =>
              toolkit.definitions.some((tool) => tool.name === call.name) && !cutOff.some((cut) => cut.id === call.id)
          )

      if (cutOff.length > 0 || approved.length > 0) {
        const pending = [
          ...cutOff.map((call) => ({ call, approved: false })),
          ...approved.map((call) => ({ call, approved: true }))
        ]

        return runCalls(toolkit, pending, history, ({ waiting }) =>
          after({ output: undefined, done: waiting, historyLength: history.length + pending.length })
        )
      }

      const prompt = Prompt.fromMessages([Prompt.systemMessage({ content: instructions.text }), ...history])
      const name = yield* Effect.serviceOption(Model.ModelName)
      const started = yield* Clock.currentTimeMillis

      const response = yield* generate(prompt, toolkit.definitions, options.toolChoice).pipe(
        Telemetry.annotateModelCall(instructions.attributes)
      )

      const metadata = response.content.find((part) => part.type === "response-metadata")

      const output = AssistantEvent.ModelOutput.make({
        parts: modelParts(response.content),
        seenThroughSequence: throughSequence,
        model: metadata?.modelId ?? Option.getOrUndefined(name),
        responseId: metadata?.id,
        usage: response.usage,
        durationMillis: (yield* Clock.currentTimeMillis) - started
      })

      const calls = toolCalls(output.parts)
      const historyLength = history.length + Prompt.fromResponseParts(output.parts).content.length + calls.length

      // A failed call doesn't end the turn: a message that failed never reached the user, so the model reads why. A call
      // that waits for approval does: the turn waits for the user.
      return Stream.make(value(output)).pipe(
        Stream.concat(
          runCalls(
            toolkit,
            calls.map((call) => ({ call, approved: false })),
            history,
            ({ failed, waiting }) =>
              after({
                output,
                done: calls.length === 0 || waiting || (!failed && calls.some(isTurnEnding)),
                historyLength
              })
          )
        )
      )
    })
  )
}

/** @internal */
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
