/**
 * A scripted model for the tests of the library's mechanics: the test says
 * what the model answers to a request, and checks what the library does with
 * it. Tests of how a real model uses the library are in `contract.test.ts`.
 */
import * as Items from "@effect-uai/core/Items"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as Turn from "@effect-uai/core/Turn"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

/** One model call, as the script sees it. */
export interface Request {
  readonly model: string
  /** The system prompt. */
  readonly system: string
  /** The history after the system prompt. */
  readonly history: ReadonlyArray<Items.HistoryItem>
  /** The tools the call offers, by name. */
  readonly tools: ReadonlyArray<string>
  readonly toolChoice: LanguageModel.CommonRequest["toolChoice"]
}

/** What the model answers to a request: its items, text and tool calls. */
export type Script = (request: Request) => ReadonlyArray<Items.HistoryItem>

/** A tool call's arguments: JSON. */
export type Json = string | number | boolean | null | ReadonlyArray<Json> | { readonly [key: string]: Json }

let calls = 0

/** A tool call, with a fresh call id. */
export const call = (name: string, args: { readonly [key: string]: Json } = {}): Items.ToolCall => ({
  type: "function_call",
  call_id: `call_${++calls}`,
  name,
  arguments: JSON.stringify(args)
})

/** A message to the user that ends the turn. */
export const reply = (text: string): ReadonlyArray<Items.HistoryItem> => [
  call("send_user_message", { text, wait: true })
]

/** Ends the turn without a message. */
export const wait = (): ReadonlyArray<Items.HistoryItem> => [call("wait")]

/** Text the model writes: a specialist's answer. */
export const text = (value: string): Items.HistoryItem => Items.assistantText(value)

/** The text of a history item the user side wrote: a message, a fact, a report. */
const inputText = (item: Items.HistoryItem): string =>
  Items.isMessage(item) && item.role === "user"
    ? item.content.flatMap((content) => (Items.isInputText(content) ? [content.text] : [])).join("")
    : ""

/** Every user-side input so far, as text. */
export const inputs = (request: Request): ReadonlyArray<string> =>
  request.history.flatMap((item) => (Items.isMessage(item) && item.role === "user" ? [inputText(item)] : []))

/** The last user-side input in the history, as text. */
export const lastInput = (request: Request): string => inputs(request).at(-1) ?? ""

/** This tool's latest result in the history, if it ran. */
export const result = (request: Request, tool: string): Option.Option<string> => {
  const calls = new Set(
    request.history.flatMap((item) => (Items.isToolCall(item) && item.name === tool ? [item.call_id] : []))
  )

  return Option.fromNullishOr(
    request.history.findLast((item) => Items.isToolCallOutput(item) && calls.has(item.call_id))
  ).pipe(Option.flatMap((item) => (Items.isToolCallOutput(item) ? Option.some(item.output) : Option.none())))
}

/** Whether the history ends with this tool's result: the step after the call. */
export const lastResult = (request: Request, tool: string): Option.Option<string> => {
  const last = request.history.at(-1)

  if (last === undefined || !Items.isToolCallOutput(last)) return Option.none()

  const called = request.history.find((item) => Items.isToolCall(item) && item.call_id === last.call_id)

  return Items.isToolCall(called) && called.name === tool ? Option.some(last.output) : Option.none()
}

const RunIdOutput = Schema.fromJsonString(Schema.Struct({ runId: Schema.String }))

/** The run id a `spawn_specialist` call returned, if the history has one. */
export const spawnedRunId = (request: Request): Option.Option<string> =>
  Option.fromNullishOr(
    request.history
      .flatMap((item) =>
        Items.isToolCallOutput(item)
          ? Option.toArray(Option.map(Schema.decodeOption(RunIdOutput)(item.output), (output) => output.runId))
          : []
      )
      .at(-1)
  )

const systemText = (history: ReadonlyArray<Items.HistoryItem>): string => {
  const first = history[0]

  return first !== undefined && Items.isMessage(first) && first.role === "system"
    ? first.content
        .flatMap((content) => (Predicate.hasProperty(content, "text") ? [String(content.text)] : []))
        .join("")
    : ""
}

/**
 * A `LanguageModel` that answers with the script, and records every request.
 */
export const make = Effect.fn(function* (script: Script) {
  const requests = yield* Ref.make<ReadonlyArray<Request>>([])

  const turn = Effect.fn(function* (request: LanguageModel.CommonRequest) {
    const scripted: Request = {
      model: request.model,
      system: systemText(request.history),
      history: request.history.slice(1),
      tools: Object.keys(request.tools ?? {}),
      toolChoice: request.toolChoice
    }

    yield* Ref.update(requests, (all) => [...all, scripted])

    const items = script(scripted)
    const toolCalls = items.some(Items.isToolCall)
    const forced = Predicate.isObject(request.toolChoice) ? request.toolChoice.name : undefined

    // A provider makes the model call a forced tool; a script that doesn't is a mistake in the test.
    if (forced !== undefined && !items.some((item) => Items.isToolCall(item) && item.name === forced)) {
      return yield* Effect.die(`The script didn't call ${forced}, which this request forces.`)
    }

    const result: Turn.Turn = { items: [...items], stop_reason: toolCalls ? "tool_calls" : "stop", usage: {} }

    return result
  })

  const service: LanguageModel.LanguageModelService = {
    turn,
    streamTurn: (request) =>
      Stream.map(Stream.fromEffect(turn(request)), (done) => Turn.TurnEvent.TurnComplete({ turn: done }))
  }

  return { layer: Layer.succeed(LanguageModel.LanguageModel, service), requests: Ref.get(requests) }
})

/** A `LanguageModel` layer that answers with the script. */
export const layer = (script: Script): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.unwrap(Effect.map(make(script), (model) => model.layer))

/** A model for tests whose handlers never call one: a call is a defect. */
export const unused: Layer.Layer<LanguageModel.LanguageModel> = layer(() => {
  throw new Error("This test's handler isn't supposed to call the model.")
})
