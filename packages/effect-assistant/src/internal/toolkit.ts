/**
 * Tools as the loop runs them: native toolkits with their handlers, merged,
 * one call at a time, every failure a result the model reads.
 */
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
import type * as AssistantLoop from "../AssistantLoop.ts"
import { AssistantToolCall } from "../AssistantToolCall.ts"
import * as ToolFailure from "../ToolFailure.ts"
import { toJson } from "./schema.ts"

const encodeFailure = Schema.encodeSync(ToolFailure.ToolFailure)

/** A failed call's outcome, with a message for the model. */
export const failed = (message: string, kind: string): AssistantLoop.CallResult => ({
  outcome: "failure",
  result: toJson(encodeFailure(ToolFailure.ToolFailure.make({ message, kind }))),
  kind
})

const decodeKind = Schema.decodeUnknownOption(Schema.Struct({ kind: Schema.String }))

const decodeTag = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))

/** A failure in its JSON form, with its kind: a `ToolFailure`'s `kind`, or its tag. */
const failure = (result: Schema.Json): AssistantLoop.CallResult => ({
  outcome: "failure",
  result,
  kind: Option.getOrUndefined(
    Option.orElse(
      Option.map(decodeKind(result), ({ kind }) => kind),
      () => Option.map(decodeTag(result), ({ _tag }) => _tag)
    )
  )
})

const hasTool = <Tools extends Record<string, Tool.Any>>(
  toolkit: { readonly tools: Tools },
  name: PropertyKey
): name is keyof Tools => Object.hasOwn(toolkit.tools, name)

// With noUncheckedIndexedAccess, an index doesn't narrow on `hasTool`.
const toolNamed = (toolkit: { readonly tools: Record<string, Tool.Any> }, name: string): Tool.Any | undefined =>
  Object.hasOwn(toolkit.tools, name) ? toolkit.tools[name] : undefined

/** What a parked call shows the user when its tool has no preview. */
export const noPreview: AssistantLoop.CallResult = { outcome: "success", result: null }

const decodeParams = (tool: Tool.Any, params: Schema.Json) => Schema.decodeUnknownEffect(tool.parametersSchema)(params)

/**
 * Whether a call waits for the user's decision: its tool's `needsApproval`,
 * with the params decoded when it's a function. Params that don't fit the
 * tool don't park: the call runs, and fails with why.
 */
export const needsDecision = Effect.fnUntraced(function* <Tools extends Record<string, Tool.Any>>(
  toolkit: { readonly tools: Tools },
  call: AssistantEvent.ToolCallPart,
  history: ReadonlyArray<Prompt.Message>
): Effect.fn.Return<boolean, never, AssistantLoop.ToolServices<Tools>> {
  const tool = toolNamed(toolkit, call.name)

  if (tool === undefined) return false

  const needs = tool.needsApproval

  if (needs === undefined || Predicate.isBoolean(needs)) return needs === true

  return yield* Effect.gen(function* () {
    const decided = needs(yield* decodeParams(tool, call.params), {
      toolCallId: call.id,
      messages: history
    })

    return Effect.isEffect(decided) ? yield* decided : decided
  }).pipe(Effect.orElseSucceed(() => false))
})

/**
 * Computes a parked call's preview, as `AssistantToolCall` for the call: its
 * value in JSON, or its `ToolFailure` as a failed result the model reads.
 */
export const preview = Effect.fnUntraced(function* <Tools extends Record<string, Tool.Any>, R>(
  toolkit: { readonly tools: Tools },
  previews: AssistantLoop.Previews<Tools, R> | undefined,
  call: AssistantEvent.ToolCallPart
): Effect.fn.Return<
  AssistantLoop.CallResult,
  never,
  AssistantLoop.ToolServices<Tools> | Exclude<R, AssistantToolCall>
> {
  const name: PropertyKey = call.name

  const tool = toolNamed(toolkit, call.name)

  if (previews === undefined || tool === undefined || !hasTool(toolkit, name)) {
    return noPreview
  }

  const make = previews[name]

  if (make === undefined) return noPreview

  return yield* Effect.gen(function* () {
    const value = yield* make(yield* decodeParams(tool, call.params))
    const result: AssistantLoop.CallResult = { outcome: "success", result: toJson(value) }

    return result
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Predicate.isTagged(error, "ToolFailure")
          ? failed(error.message, error.kind ?? "ToolFailure")
          : failed(`Invalid parameters for ${call.name}.`, "ToolParameterValidationError")
      )
    ),
    Effect.provideService(AssistantToolCall, { callId: call.id, tool: call.name })
  )
})

// The toolkit decodes the params with the tool's schema before its handler sees them, and a call whose params don't
// fit fails with a validation error the model reads: the model's JSON is what `handle` takes.
const isParams = <T>(params: unknown): params is Tool.ParametersEncoded<T> => params !== undefined

/**
 * Runs a call with a resolved native toolkit, as `AssistantToolCall` for its
 * handler. A failure is the call's result: an `AiError` (params that don't fit,
 * say) as a `ToolFailure` of the reason's kind, and the tool's own failure in
 * its JSON form (with `failureMode: "return"`, the toolkit encodes it with its
 * schema first).
 */
export const runNative = Effect.fnUntraced(function* <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
  call: AssistantEvent.ToolCallPart
): Effect.fn.Return<AssistantLoop.CallResult, never, AssistantLoop.ToolServices<Tools>> {
  const name: PropertyKey = call.name

  if (!hasTool(toolkit, name)) return failed(`No tool named ${call.name}.`, "ToolNotFoundError")

  const params: unknown = call.params

  if (!isParams<Tools[keyof Tools]>(params)) {
    return failed(`Invalid parameters for ${call.name}.`, "ToolParameterValidationError")
  }

  return yield* Effect.gen(function* () {
    const results = yield* toolkit.handle<keyof Tools>(name, params, call.id)
    const last = yield* Stream.runLast(Stream.filter(results, (result) => !result.preliminary))

    return Option.match(last, {
      onNone: () => failed(`${call.name} returned no result.`, "NoResult"),
      onSome: (result): AssistantLoop.CallResult =>
        result.isFailure
          ? failure(toJson(result.encodedResult))
          : { outcome: "success", result: toJson(result.encodedResult) }
    })
  }).pipe(
    Effect.catch((cause) => {
      const error: unknown = cause

      return Effect.succeed(
        AiError.isAiError(error) ? failed(error.reason.message, error.reason._tag) : failure(toJson(error))
      )
    }),
    Effect.provideService(AssistantToolCall, { callId: call.id, tool: call.name })
  )
})

/** Tools from a resolved native toolkit. */
export const fromWithHandler = <Tools extends Record<string, Tool.Any>, R = never>(
  toolkit: Toolkit.WithHandler<Tools>,
  previews?: AssistantLoop.Previews<Tools, R>
): AssistantLoop.Tools<AssistantLoop.ToolServices<Tools> | Exclude<R, AssistantToolCall>> => ({
  definitions: Object.values(toolkit.tools),
  run: (call) => runNative(toolkit, call),
  needsDecision: (call, history) => needsDecision(toolkit, call, history),
  preview: (call) => preview(toolkit, previews, call)
})

/** Tools from a native toolkit whose handlers are in context when a call runs. */
export const fromToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
): AssistantLoop.Tools<AssistantLoop.ToolServices<Tools> | Tool.HandlersFor<Tools>> => ({
  definitions: Object.values(toolkit.tools),
  run: Effect.fnUntraced(function* (call) {
    return yield* runNative(yield* toolkit, call)
  }),
  needsDecision: (call, history) => needsDecision(toolkit, call, history)
})

/** Tools from a native toolkit and its handlers. */
export const withHandlers = <Tools extends Record<string, Tool.Any>, R = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Toolkit.HandlersFrom<Tools>,
  previews?: AssistantLoop.Previews<Tools, R>
): AssistantLoop.Tools<AssistantLoop.ToolServices<Tools> | Exclude<R, AssistantToolCall>> => ({
  definitions: Object.values(toolkit.tools),
  run: Effect.fnUntraced(function* (call) {
    const resolved = yield* Effect.provideContext(toolkit, yield* toolkit.toHandlers(handlers))

    return yield* runNative(resolved, call)
  }),
  needsDecision: (call, history) => needsDecision(toolkit, call, history),
  preview: (call) => preview(toolkit, previews, call)
})

/**
 * Tools from a native toolkit whose handlers use services of the loop they
 * run in: they're made for each call, with its context.
 */
export const withContext = <Tools extends Record<string, Tool.Any>, R>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: (context: Context.Context<R>) => Toolkit.HandlersFrom<Tools>
): AssistantLoop.Tools<R | AssistantLoop.ToolServices<Tools>> => ({
  definitions: Object.values(toolkit.tools),
  run: Effect.fnUntraced(function* (call) {
    const context = yield* Effect.context<R>()
    const resolved = yield* Effect.provideContext(toolkit, yield* toolkit.toHandlers(handlers(context)))

    return yield* runNative(resolved, call)
  }),
  needsDecision: (call, history) => needsDecision(toolkit, call, history)
})

/** No tools. */
export const empty: AssistantLoop.Tools = {
  definitions: [],
  run: (call) => Effect.succeed(failed(`No tool named ${call.name}.`, "ToolNotFoundError"))
}

/** Two sets of tools together. A call goes to the one that has its tool. */
export const merge = <A, B>(self: AssistantLoop.Tools<A>, that: AssistantLoop.Tools<B>): AssistantLoop.Tools<A | B> => {
  const inSelf = (call: AssistantEvent.ToolCallPart) => self.definitions.some((tool) => tool.name === call.name)

  return {
    definitions: [...self.definitions, ...that.definitions],
    run: (call) => (inSelf(call) ? self.run(call) : that.run(call)),
    needsDecision: (call, history) =>
      inSelf(call) ? needsDecisionOf(self, call, history) : needsDecisionOf(that, call, history),
    preview: (call) => (inSelf(call) ? previewOf(self, call) : previewOf(that, call))
  }
}

/** Whether these tools park a call: never, unless they say how. */
export const needsDecisionOf = <R>(
  tools: AssistantLoop.Tools<R>,
  call: AssistantEvent.ToolCallPart,
  history: ReadonlyArray<Prompt.Message>
): Effect.Effect<boolean, never, R> =>
  tools.needsDecision === undefined ? Effect.succeed(false) : tools.needsDecision(call, history)

/** A parked call's preview from these tools: none, unless they have one. */
export const previewOf = <R>(
  tools: AssistantLoop.Tools<R>,
  call: AssistantEvent.ToolCallPart
): Effect.Effect<AssistantLoop.CallResult, never, R> =>
  tools.preview === undefined ? Effect.succeed(noPreview) : tools.preview(call)

/** The names used by more than one tool. */
export const duplicateNames = (tools: AssistantLoop.Tools<unknown>): ReadonlyArray<string> => {
  const names = tools.definitions.map((tool) => tool.name)

  return names.filter((name, i) => names.indexOf(name) !== i)
}

/**
 * The same tools offered, so the prompt doesn't change, but only the named
 * ones run: a call to any other fails with this message.
 */
export const runOnly = <R>(
  tools: AssistantLoop.Tools<R>,
  names: ReadonlyArray<string>,
  message: string
): AssistantLoop.Tools<R> => ({
  definitions: tools.definitions,
  run: (call) => (names.includes(call.name) ? tools.run(call) : Effect.succeed(failed(message, "not_now"))),
  needsDecision: (call, history) =>
    names.includes(call.name) ? needsDecisionOf(tools, call, history) : Effect.succeed(false),
  preview: (call) => previewOf(tools, call)
})

/**
 * Only the tools `allowed` admits: the model doesn't see the others, and a
 * call to one (to run, to decide on, or to preview) fails as if it didn't
 * exist.
 */
export const only = <R>(
  tools: AssistantLoop.Tools<R>,
  allowed: (tool: Tool.Any) => boolean
): AssistantLoop.Tools<R> => {
  const definitions = tools.definitions.filter(allowed)
  const names = new Set(definitions.map((tool) => tool.name))

  const missing = (call: AssistantEvent.ToolCallPart) =>
    Effect.succeed(failed(`No tool named ${call.name}.`, "ToolNotFoundError"))

  return {
    definitions,
    run: (call) => (names.has(call.name) ? tools.run(call) : missing(call)),
    needsDecision: (call, history) =>
      names.has(call.name) ? needsDecisionOf(tools, call, history) : Effect.succeed(false),
    preview: (call) => (names.has(call.name) ? previewOf(tools, call) : missing(call))
  }
}
