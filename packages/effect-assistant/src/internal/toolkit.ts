/**
 * Tools as the loop runs them: native toolkits with their handlers, merged,
 * one call at a time, every failure a result the model reads.
 *
 * @since 0.1.0
 * @internal
 */
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as AiError from "effect/unstable/ai/AiError"
import type * as Tool from "effect/unstable/ai/Tool"
import type * as Toolkit from "effect/unstable/ai/Toolkit"
import type * as AssistantEvent from "../AssistantEvent.ts"
import type * as AssistantLoop from "../AssistantLoop.ts"
import { AssistantToolCall } from "../AssistantToolCall.ts"
import * as ToolFailure from "../ToolFailure.ts"
import { toJson } from "./schema.ts"

const encodeFailure = Schema.encodeSync(ToolFailure.ToolFailure)

/**
 * A failed call's outcome, with a message for the model.
 *
 * @internal
 */
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
  toolkit: Toolkit.WithHandler<Tools>,
  name: PropertyKey
): name is keyof Tools => Object.hasOwn(toolkit.tools, name)

// The toolkit decodes the params with the tool's schema before its handler sees them, and a call whose params don't
// fit fails with a validation error the model reads: the model's JSON is what `handle` takes.
const isParams = <T>(params: unknown): params is Tool.ParametersEncoded<T> => params !== undefined

/**
 * Runs a call with a resolved native toolkit, as `AssistantToolCall` for its
 * handler. A failure is the call's result: an `AiError` (params that don't fit,
 * say) as a `ToolFailure` of the reason's kind, and the tool's own failure in
 * its JSON form (with `failureMode: "return"`, the toolkit encodes it with its
 * schema first).
 *
 * @internal
 */
export const runNative = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
  call: AssistantEvent.ToolCallPart
): Effect.Effect<AssistantLoop.CallResult, never, AssistantLoop.ToolServices<Tools>> => {
  const name: PropertyKey = call.name

  if (!hasTool(toolkit, name)) return Effect.succeed(failed(`No tool named ${call.name}.`, "ToolNotFoundError"))

  const params: unknown = call.params

  if (!isParams<Tools[keyof Tools]>(params)) {
    return Effect.succeed(failed(`Invalid parameters for ${call.name}.`, "ToolParameterValidationError"))
  }

  return toolkit.handle<keyof Tools>(name, params, call.id).pipe(
    Effect.flatMap((results) => Stream.runLast(Stream.filter(results, (result) => !result.preliminary))),
    Effect.map(
      Option.match({
        onNone: () => failed(`${call.name} returned no result.`, "NoResult"),
        onSome: (result): AssistantLoop.CallResult =>
          result.isFailure
            ? failure(toJson(result.encodedResult))
            : { outcome: "success", result: toJson(result.encodedResult) }
      })
    ),
    Effect.catch((cause) => {
      const error: unknown = cause

      return Effect.succeed(
        AiError.isAiError(error) ? failed(error.reason.message, error.reason._tag) : failure(toJson(error))
      )
    }),
    Effect.provideService(AssistantToolCall, { callId: call.id, tool: call.name })
  )
}

/**
 * Tools from a resolved native toolkit.
 *
 * @internal
 */
export const fromWithHandler = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>
): AssistantLoop.Tools<AssistantLoop.ToolServices<Tools>> => ({
  definitions: Object.values(toolkit.tools),
  run: (call) => runNative(toolkit, call)
})

/**
 * Tools from a native toolkit whose handlers are in context when a call runs.
 *
 * @internal
 */
export const fromToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
): AssistantLoop.Tools<AssistantLoop.ToolServices<Tools> | Tool.HandlersFor<Tools>> => ({
  definitions: Object.values(toolkit.tools),
  run: (call) => Effect.flatMap(toolkit, (resolved) => runNative(resolved, call))
})

/**
 * Tools from a native toolkit and its handlers.
 *
 * @internal
 */
export const withHandlers = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Toolkit.HandlersFrom<Tools>
): AssistantLoop.Tools<AssistantLoop.ToolServices<Tools>> => ({
  definitions: Object.values(toolkit.tools),
  run: (call) =>
    toolkit.toHandlers(handlers).pipe(
      Effect.flatMap((context) => Effect.provideContext(toolkit, context)),
      Effect.flatMap((resolved) => runNative(resolved, call))
    )
})

/**
 * Tools from a native toolkit whose handlers use services of the loop they
 * run in: they're made for each call, with its context.
 *
 * @internal
 */
export const withContext = <Tools extends Record<string, Tool.Any>, R>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: (context: Context.Context<R>) => Toolkit.HandlersFrom<Tools>
): AssistantLoop.Tools<R | AssistantLoop.ToolServices<Tools>> => ({
  definitions: Object.values(toolkit.tools),
  run: (call) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>()
      const resolved = yield* Effect.provideContext(toolkit, yield* toolkit.toHandlers(handlers(context)))

      return yield* runNative(resolved, call)
    })
})

/**
 * No tools.
 *
 * @internal
 */
export const empty: AssistantLoop.Tools = {
  definitions: [],
  run: (call) => Effect.succeed(failed(`No tool named ${call.name}.`, "ToolNotFoundError"))
}

/**
 * Two sets of tools together. A call goes to the one that has its tool.
 *
 * @internal
 */
export const merge = <A, B>(
  self: AssistantLoop.Tools<A>,
  that: AssistantLoop.Tools<B>
): AssistantLoop.Tools<A | B> => ({
  definitions: [...self.definitions, ...that.definitions],
  run: (call) => (self.definitions.some((tool) => tool.name === call.name) ? self.run(call) : that.run(call))
})

/**
 * The names used by more than one tool.
 *
 * @internal
 */
export const duplicateNames = (tools: AssistantLoop.Tools<unknown>): ReadonlyArray<string> => {
  const names = tools.definitions.map((tool) => tool.name)

  return names.filter((name, i) => names.indexOf(name) !== i)
}

/**
 * Only the named tools.
 *
 * @internal
 */
export const only = <R>(tools: AssistantLoop.Tools<R>, names: ReadonlyArray<string>): AssistantLoop.Tools<R> => ({
  definitions: tools.definitions.filter((tool) => names.includes(tool.name)),
  run: (call) => (names.includes(call.name) ? tools.run(call) : empty.run(call))
})
