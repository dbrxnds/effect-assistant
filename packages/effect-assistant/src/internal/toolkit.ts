import * as AiError from "effect/ai/AiError"
import type * as Prompt from "effect/ai/Prompt"
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as AssistantEvent from "../AssistantEvent.ts"
import { AssistantToolCall } from "../AssistantToolCall.ts"
import * as ToolFailure from "../ToolFailure.ts"
import { toJson } from "./schema.ts"

/** @internal */
export interface CallResult {
  readonly outcome: AssistantEvent.ToolOutcome
  readonly result: Schema.Json
  readonly reason?: string | undefined
}

// Apps give the loop native toolkits; these are what the loop makes of them, merged with its own.
/** @internal */
export interface Tools<out R = never> {
  readonly definitions: ReadonlyArray<Tool.Any>
  readonly run: (call: AssistantEvent.ToolCallPart) => Effect.Effect<CallResult, never, R>
  // Whether the call waits for the user's approval instead of running: its tool's `needsApproval`.
  readonly needsApproval: (
    call: AssistantEvent.ToolCallPart,
    history: ReadonlyArray<Prompt.Message>
  ) => Effect.Effect<boolean, never, R>
}

/** @internal */
export type ToolServices<T extends Record<string, Tool.Any>> =
  | Exclude<Tool.HandlerServices<T[keyof T]>, AssistantToolCall>
  // Already in the handlers' services; stated for the loop, which decodes params to ask `needsApproval`.
  | T[keyof T]["parametersSchema"]["DecodingServices"]

const encodeFailure = Schema.encodeSync(ToolFailure.ToolFailure)

/** @internal */
export const failed = (message: string, reason: string): CallResult => ({
  outcome: "failure",
  result: toJson(encodeFailure(new ToolFailure.ToolFailure({ message, reason }))),
  reason
})

const decodeReason = Schema.decodeUnknownOption(Schema.Struct({ reason: Schema.String }))

const decodeTag = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))

const failure = (result: Schema.Json): CallResult => ({
  outcome: "failure",
  result,
  reason: Option.getOrUndefined(
    Option.orElse(
      Option.map(decodeReason(result), ({ reason }) => reason),
      () => Option.map(decodeTag(result), ({ _tag }) => _tag)
    )
  )
})

const hasTool = <T extends Record<string, Tool.Any>>(
  toolkit: { readonly tools: T },
  name: PropertyKey
): name is keyof T => Object.hasOwn(toolkit.tools, name)

/** @internal */
export const needingApproval = (definitions: ReadonlyArray<Tool.Any>): ReadonlyArray<string> =>
  definitions.flatMap((tool) => (tool.needsApproval === undefined || tool.needsApproval === false ? [] : [tool.name]))

// With noUncheckedIndexedAccess, an index doesn't narrow on `hasTool`.
const toolNamed = (toolkit: { readonly tools: Record<string, Tool.Any> }, name: string): Tool.Any | undefined =>
  Object.hasOwn(toolkit.tools, name) ? toolkit.tools[name] : undefined

// Params that don't fit the tool don't wait: the call runs, and fails with why.
const needsApprovalNative = Effect.fnUntraced(function* <T extends Record<string, Tool.Any>>(
  toolkit: { readonly tools: T },
  call: AssistantEvent.ToolCallPart,
  history: ReadonlyArray<Prompt.Message>
): Effect.fn.Return<boolean, never, ToolServices<T>> {
  const tool = toolNamed(toolkit, call.name)
  const needs = tool?.needsApproval

  if (tool === undefined || needs === undefined || Predicate.isBoolean(needs)) return needs === true

  return yield* Effect.gen(function* () {
    const params = yield* Schema.decodeUnknownEffect(tool.parametersSchema)(call.params)
    const decided = needs(params, { toolCallId: call.id, messages: history })

    return Effect.isEffect(decided) ? yield* decided : decided
  }).pipe(Effect.orElseSucceed(() => false))
})

// The toolkit decodes the params with the tool's schema before its handler sees them, and a call whose params don't
// fit fails with a validation error the model reads: the model's JSON is what `handle` takes.
const isParams = <T>(params: unknown): params is Tool.ParametersEncoded<T> => params !== undefined

// Every failure is the call's result, for the model to read. With `failureMode: "return"` the toolkit encodes the
// tool's own failure with its schema first.
/** @internal */
export const runNative = Effect.fnUntraced(function* <T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<T>,
  call: AssistantEvent.ToolCallPart
): Effect.fn.Return<CallResult, never, ToolServices<T>> {
  const name: PropertyKey = call.name

  if (!hasTool(toolkit, name)) return failed(`No tool named ${call.name}.`, "ToolNotFoundError")

  const params: unknown = call.params

  if (!isParams<T[keyof T]>(params)) {
    return failed(`Invalid parameters for ${call.name}.`, "ToolParameterValidationError")
  }

  return yield* Effect.gen(function* () {
    const results = yield* toolkit.handle<keyof T>(name, params, call.id)
    const last = yield* Stream.runLast(Stream.filter(results, (result) => !result.preliminary))

    return Option.match(last, {
      onNone: () => failed(`${call.name} returned no result.`, "NoResult"),
      onSome: (result): CallResult =>
        result.isFailure
          ? failure(toJson(result.encodedResult))
          : { outcome: "success", result: toJson(result.encodedResult) }
    })
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        AiError.isAiError(error) ? failed(error.reason.message, error.reason._tag) : failure(toJson(error))
      )
    ),
    Effect.provideService(AssistantToolCall, { callId: call.id, tool: call.name })
  )
})

/** @internal */
export const fromWithHandler = <T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<T>
): Tools<ToolServices<T>> => ({
  definitions: Object.values(toolkit.tools),
  run: (call) => runNative(toolkit, call),
  needsApproval: (call, history) => needsApprovalNative(toolkit, call, history)
})

/** @internal */
export const fromToolkit = <T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<T>
): Tools<ToolServices<T> | Tool.HandlersFor<T>> => ({
  definitions: Object.values(toolkit.tools),
  run: Effect.fnUntraced(function* (call) {
    return yield* runNative(yield* toolkit, call)
  }),
  needsApproval: (call, history) => needsApprovalNative(toolkit, call, history)
})

/** @internal */
export const fromToolkitOrEmpty = <T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<T> | undefined
): Tools<ToolServices<T> | Tool.HandlersFor<T>> => (toolkit === undefined ? empty : fromToolkit(toolkit))

/** @internal */
export const empty: Tools = {
  definitions: [],
  run: (call) => Effect.succeed(failed(`No tool named ${call.name}.`, "ToolNotFoundError")),
  needsApproval: () => Effect.succeed(false)
}

/** @internal */
export const merge = <A, B>(self: Tools<A>, that: Tools<B>): Tools<A | B> => {
  const inSelf = (call: AssistantEvent.ToolCallPart) => self.definitions.some((tool) => tool.name === call.name)

  return {
    definitions: [...self.definitions, ...that.definitions],
    run: (call) => (inSelf(call) ? self.run(call) : that.run(call)),
    needsApproval: (call, history) =>
      inSelf(call) ? self.needsApproval(call, history) : that.needsApproval(call, history)
  }
}

// A turn's own services, for a loop the app writes.
/** @internal */
export const provide = <R>(tools: Tools<R>, context: Context.Context<R>): Tools => ({
  definitions: tools.definitions,
  run: (call) => Effect.provideContext(tools.run(call), context),
  needsApproval: (call, history) => Effect.provideContext(tools.needsApproval(call, history), context)
})

/** @internal */
export const duplicateNames = (tools: Tools<unknown>): ReadonlyArray<string> => {
  const names = tools.definitions.map((tool) => tool.name)

  return names.filter((name, i) => names.indexOf(name) !== i)
}

// The same tools are offered, so the prompt doesn't change.
/** @internal */
export const runOnly = <R>(tools: Tools<R>, names: ReadonlyArray<string>, message: string): Tools<R> => ({
  definitions: tools.definitions,
  run: (call) => (names.includes(call.name) ? tools.run(call) : Effect.succeed(failed(message, "NotNow"))),
  // Refused like any other call it doesn't run.
  needsApproval: () => Effect.succeed(false)
})
