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
import { AssistantToolCall } from "../AssistantToolCall.ts"
import * as ToolFailure from "../ToolFailure.ts"
import { toJson } from "./schema.ts"

/**
 * How a tool call went: success or failure, its result in JSON, as the model
 * reads it, and a failure's kind when it has one.
 */
export interface CallResult {
  readonly outcome: AssistantEvent.ToolOutcome
  readonly result: Schema.Json
  readonly kind?: string | undefined
}

/**
 * Tools as the loop runs them: their definitions, as the model sees them, how
 * to run a call to one, and whether a call waits for the user's decision.
 * `R` is what running them needs. Apps give the loop native toolkits; these
 * are what the loop makes of them, merged with its own.
 */
export interface Tools<out R = never> {
  readonly definitions: ReadonlyArray<Tool.Any>
  readonly run: (call: AssistantEvent.ToolCallPart) => Effect.Effect<CallResult, never, R>
  /** Whether a call waits for the user's decision instead of running: its tool's `needsApproval`. Default: never. */
  readonly needsDecision?:
    | ((call: AssistantEvent.ToolCallPart, history: ReadonlyArray<Prompt.Message>) => Effect.Effect<boolean, never, R>)
    | undefined
}

/** What a toolkit's handlers need to run, besides the call the loop provides. */
export type ToolServices<T extends Record<string, Tool.Any>> =
  | Exclude<Tool.HandlerServices<T[keyof T]>, AssistantToolCall>
  // Already in the handlers' services; stated for the loop, which decodes params to decide on a call.
  | T[keyof T]["parametersSchema"]["DecodingServices"]

const encodeFailure = Schema.encodeSync(ToolFailure.ToolFailure)

/** A failed call's outcome, with a message for the model. */
export const failed = (message: string, kind: string): CallResult => ({
  outcome: "failure",
  result: toJson(encodeFailure(ToolFailure.ToolFailure.make({ message, kind }))),
  kind
})

const decodeKind = Schema.decodeUnknownOption(Schema.Struct({ kind: Schema.String }))

const decodeTag = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))

/** A failure in its JSON form, with its kind: a `ToolFailure`'s `kind`, or its tag. */
const failure = (result: Schema.Json): CallResult => ({
  outcome: "failure",
  result,
  kind: Option.getOrUndefined(
    Option.orElse(
      Option.map(decodeKind(result), ({ kind }) => kind),
      () => Option.map(decodeTag(result), ({ _tag }) => _tag)
    )
  )
})

const hasTool = <T extends Record<string, Tool.Any>>(
  toolkit: { readonly tools: T },
  name: PropertyKey
): name is keyof T => Object.hasOwn(toolkit.tools, name)

// With noUncheckedIndexedAccess, an index doesn't narrow on `hasTool`.
const toolNamed = (toolkit: { readonly tools: Record<string, Tool.Any> }, name: string): Tool.Any | undefined =>
  Object.hasOwn(toolkit.tools, name) ? toolkit.tools[name] : undefined

const decodeParams = (tool: Tool.Any, params: Schema.Json) => Schema.decodeUnknownEffect(tool.parametersSchema)(params)

/**
 * Whether a call waits for the user's decision: its tool's `needsApproval`,
 * with the params decoded when it's a function. Params that don't fit the
 * tool don't park: the call runs, and fails with why.
 */
export const needsDecision = Effect.fnUntraced(function* <T extends Record<string, Tool.Any>>(
  toolkit: { readonly tools: T },
  call: AssistantEvent.ToolCallPart,
  history: ReadonlyArray<Prompt.Message>
): Effect.fn.Return<boolean, never, ToolServices<T>> {
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
export const fromWithHandler = <T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<T>
): Tools<ToolServices<T>> => ({
  definitions: Object.values(toolkit.tools),
  run: (call) => runNative(toolkit, call),
  needsDecision: (call, history) => needsDecision(toolkit, call, history)
})

/** Tools from a native toolkit whose handlers are in context when a call runs. */
export const fromToolkit = <T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<T>
): Tools<ToolServices<T> | Tool.HandlersFor<T>> => ({
  definitions: Object.values(toolkit.tools),
  run: Effect.fnUntraced(function* (call) {
    return yield* runNative(yield* toolkit, call)
  }),
  needsDecision: (call, history) => needsDecision(toolkit, call, history)
})

/**
 * Tools from a native toolkit whose handlers use services of the loop they
 * run in: they're made for each call, with its context.
 */
export const withContext = <T extends Record<string, Tool.Any>, R>(
  toolkit: Toolkit.Toolkit<T>,
  handlers: (context: Context.Context<R>) => Toolkit.HandlersFrom<T>
): Tools<R | ToolServices<T>> => ({
  definitions: Object.values(toolkit.tools),
  run: Effect.fnUntraced(function* (call) {
    const context = yield* Effect.context<R>()
    const resolved = yield* Effect.provideContext(toolkit, yield* toolkit.toHandlers(handlers(context)))

    return yield* runNative(resolved, call)
  }),
  needsDecision: (call, history) => needsDecision(toolkit, call, history)
})

/** Tools from a native toolkit whose handlers are in context, or none. */
export const fromToolkitOrEmpty = <T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<T> | undefined
): Tools<ToolServices<T> | Tool.HandlersFor<T>> => (toolkit === undefined ? empty : fromToolkit(toolkit))

/** `search_tools` and `execute_tool` over a catalog toolkit, or none. */
export const catalogOf = <T extends Record<string, Tool.Any>>(
  catalog: Toolkit.Toolkit<T> | undefined,
  discover: <R>(tools: Tools<R>) => Tools<R>
): Tools<ToolServices<T> | Tool.HandlersFor<T>> => (catalog === undefined ? empty : discover(fromToolkit(catalog)))

/** No tools. */
export const empty: Tools = {
  definitions: [],
  run: (call) => Effect.succeed(failed(`No tool named ${call.name}.`, "ToolNotFoundError"))
}

/** Two sets of tools together. A call goes to the one that has its tool. */
export const merge = <A, B>(self: Tools<A>, that: Tools<B>): Tools<A | B> => {
  const inSelf = (call: AssistantEvent.ToolCallPart) => self.definitions.some((tool) => tool.name === call.name)

  return {
    definitions: [...self.definitions, ...that.definitions],
    run: (call) => (inSelf(call) ? self.run(call) : that.run(call)),
    needsDecision: (call, history) =>
      inSelf(call) ? needsDecisionOf(self, call, history) : needsDecisionOf(that, call, history)
  }
}

/** Whether these tools park a call: never, unless they say how. */
export const needsDecisionOf = <R>(
  tools: Tools<R>,
  call: AssistantEvent.ToolCallPart,
  history: ReadonlyArray<Prompt.Message>
): Effect.Effect<boolean, never, R> =>
  tools.needsDecision === undefined ? Effect.succeed(false) : tools.needsDecision(call, history)

/** These tools with the services they need provided: a turn's own, for a loop the app writes. */
export const provide = <R>(tools: Tools<R>, context: Context.Context<R>): Tools => ({
  definitions: tools.definitions,
  run: (call) => Effect.provideContext(tools.run(call), context),
  needsDecision: (call, history) => Effect.provideContext(needsDecisionOf(tools, call, history), context)
})

/** The names used by more than one tool. */
export const duplicateNames = (tools: Tools<unknown>): ReadonlyArray<string> => {
  const names = tools.definitions.map((tool) => tool.name)

  return names.filter((name, i) => names.indexOf(name) !== i)
}

/**
 * The same tools offered, so the prompt doesn't change, but only the named
 * ones run: a call to any other fails with this message.
 */
export const runOnly = <R>(tools: Tools<R>, names: ReadonlyArray<string>, message: string): Tools<R> => ({
  definitions: tools.definitions,
  run: (call) => (names.includes(call.name) ? tools.run(call) : Effect.succeed(failed(message, "not_now"))),
  needsDecision: (call, history) =>
    names.includes(call.name) ? needsDecisionOf(tools, call, history) : Effect.succeed(false)
})
