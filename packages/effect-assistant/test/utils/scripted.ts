/**
 * A scripted model for the tests of the library's mechanics: the test says
 * what the model answers to a request, and checks what the library does with
 * it. Tests of how a real model uses the library are in `contract.test.ts`.
 */
import * as LanguageModel from "effect/ai/LanguageModel"
import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { toJsonText } from "../../src/internal/schema.ts"

/** One model call, as the script sees it. */
export interface Request {
  /** The system prompt. */
  readonly system: string
  /** The history after the system prompt. */
  readonly history: ReadonlyArray<Prompt.Message>
  /** The tools the call offers, by name. */
  readonly tools: ReadonlyArray<string>
  /** The tools' descriptions, as the model reads them. */
  readonly descriptions: ReadonlyMap<string, string>
  readonly toolChoice: LanguageModel.ToolChoice<string>
}

/** What the model answers to a request: its parts, text and tool calls. */
export type Script = (request: Request) => ReadonlyArray<Response.PartEncoded>

/** A tool call's arguments: JSON. */
export type Json = string | number | boolean | null | ReadonlyArray<Json> | { readonly [key: string]: Json }

let calls = 0

/** The model id the scripted model reports. */
export const model = "scripted-model"

/** A tool call, with a fresh call id. */
export const call = (name: string, params: { readonly [key: string]: Json } = {}): Response.ToolCallPartEncoded => ({
  type: "tool-call",
  id: `call_${++calls}`,
  name,
  params
})

/** A message to the user that ends the turn. */
export const reply = (text: string): ReadonlyArray<Response.PartEncoded> => [
  call("send_user_message", { text, wait: true })
]

/** Ends the turn without a message. */
export const wait = (): ReadonlyArray<Response.PartEncoded> => [call("wait")]

/** Text the model writes: a specialist's answer. */
export const text = (value: string): Response.TextPartEncoded => ({ type: "text", text: value })

/** The text of a user message: a message, a fact, a report. */
const userText = (message: Prompt.Message): ReadonlyArray<string> =>
  message.role === "user" ? [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")] : []

/** Every user-side input so far, as text. */
export const inputs = (request: Request): ReadonlyArray<string> => request.history.flatMap(userText)

/** The last user-side input in the history, as text. */
export const lastInput = (request: Request): string => inputs(request).at(-1) ?? ""

/** The tool calls in the history. */
export const toolCalls = (request: Request): ReadonlyArray<Prompt.ToolCallPart> =>
  request.history.flatMap((message) =>
    message.role === "assistant" ? message.content.flatMap((part) => (part.type === "tool-call" ? [part] : [])) : []
  )

/** The tool results in the history. */
export const toolResults = (request: Request): ReadonlyArray<Prompt.ToolResultPart> =>
  request.history.flatMap((message) =>
    message.role === "tool" ? message.content.flatMap((part) => (part.type === "tool-result" ? [part] : [])) : []
  )

/** A result as the model reads it: a string as it is, anything else as JSON. */
export const resultText = (result: Prompt.ToolResultPart): string =>
  Predicate.isString(result.result) ? result.result : toJsonText(result.result)

/** Whether the model called this tool. */
export const hasCalled = (request: Request, tool: string): boolean =>
  toolCalls(request).some((part) => part.name === tool)

/** This tool's latest result in the history, if it ran. */
export const result = (request: Request, tool: string): Option.Option<string> =>
  Option.map(Option.fromNullishOr(toolResults(request).findLast((part) => part.name === tool)), resultText)

/** Whether the history ends with this tool's result: the step after the call. */
export const lastResult = (request: Request, tool: string): Option.Option<string> => {
  const last = request.history.at(-1)

  if (last === undefined || last.role !== "tool") return Option.none()

  const part = last.content.at(-1)

  return part !== undefined && part.type === "tool-result" && part.name === tool
    ? Option.some(resultText(part))
    : Option.none()
}

const RunIdResult = Schema.Struct({ runId: Schema.String })

/** The run id a `spawn_specialist` call returned, if the history has one. */
export const spawnedRunId = (request: Request): Option.Option<string> =>
  Option.fromNullishOr(
    toolResults(request)
      .flatMap((part) =>
        Option.toArray(Option.map(Schema.decodeUnknownOption(RunIdResult)(part.result), (output) => output.runId))
      )
      .at(-1)
  )

/**
 * A `LanguageModel` that answers with the script, and records every request.
 */
export const make = Effect.fn(function* (script: Script) {
  const requests = yield* Ref.make<ReadonlyArray<Request>>([])

  const generate = Effect.fn(function* (options: LanguageModel.ProviderOptions) {
    const [first, ...rest] = options.prompt.content
    const system = first !== undefined && first.role === "system" ? first.content : ""

    const scripted: Request = {
      system,
      history: first !== undefined && first.role === "system" ? rest : options.prompt.content,
      tools: options.tools.map((tool) => tool.name),
      descriptions: new Map(options.tools.map((tool) => [tool.name, tool.description ?? ""])),
      toolChoice: options.toolChoice
    }

    yield* Ref.update(requests, (all) => [...all, scripted])

    const parts = script(scripted)
    const toolCalls = parts.some((part) => part.type === "tool-call")
    const { toolChoice } = options
    const forced = Predicate.isObject(toolChoice) && "tool" in toolChoice ? toolChoice.tool : undefined

    // A provider makes the model call a forced tool; a script that doesn't is a mistake in the test.
    if (forced !== undefined && !parts.some((part) => part.type === "tool-call" && part.name === forced)) {
      return yield* Effect.die(`The script didn't call ${forced}, which this request forces.`)
    }

    const metadata: Response.ResponseMetadataPartEncoded = {
      type: "response-metadata",
      id: `response_${(yield* Ref.get(requests)).length}`,
      modelId: model
    }

    const finish: Response.FinishPartEncoded = {
      type: "finish",
      reason: toolCalls ? "tool-calls" : "stop",
      usage: {
        inputTokens: { total: 120, uncached: 20, cacheRead: 100, cacheWrite: 0 },
        outputTokens: { total: 8 }
      }
    }

    return [metadata, ...parts, finish]
  })

  const service = yield* LanguageModel.make({
    generateText: generate,
    streamText: () => Stream.die("The scripted model doesn't stream.")
  })

  return { layer: Layer.succeed(LanguageModel.LanguageModel, service), requests: Ref.get(requests) }
})

/** A `LanguageModel` layer that answers with the script. */
export const layer = (script: Script): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.unwrap(Effect.map(make(script), (model) => model.layer))

/** A model for tests whose handlers never call one: a call is a defect. */
export const unused: Layer.Layer<LanguageModel.LanguageModel> = layer(() => {
  throw new Error("This test's handler isn't supposed to call the model.")
})
