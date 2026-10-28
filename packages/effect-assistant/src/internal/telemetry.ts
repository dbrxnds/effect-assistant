import * as Model from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import * as Telemetry from "effect/ai/Telemetry"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import * as AssistantEvent from "../AssistantEvent.ts"
import type { SpanAttributes } from "../Instructions.ts"
import { toJsonText } from "./schema.ts"

type Traced = string | ReadonlyArray<{ readonly _tag: string }>

// Spans follow the OpenTelemetry GenAI conventions, so LLM tools (Langfuse, Phoenix, Datadog LLM Observability) can
// pick the agent work out of a trace.
/** @internal */
export const agentSpan = (name: string, options: { readonly chatId: string; readonly root?: boolean }) =>
  Effect.withSpan(`invoke_agent ${name}`, {
    kind: "internal",
    root: options.root ?? false,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": name,
      "gen_ai.conversation.id": options.chatId,
      "session.id": options.chatId
    }
  })

// None when tracing is off, or when the tracer is Effect's own, which exports nothing.
/** @internal */
export const currentTraceId: Effect.Effect<Option.Option<string>> = Effect.gen(function* () {
  const tracer = yield* Tracer.Tracer

  if (!(yield* References.TracerEnabled) || tracer === Tracer.nativeTracer) return Option.none()

  return Option.map(yield* Effect.option(Effect.currentSpan), (span) => span.traceId)
})

/** @internal */
export const agentInput = (input: Traced) => Effect.annotateCurrentSpan("input.value", toJsonText(input))

/** @internal */
export const agentOutput = (output: Traced) => Effect.annotateCurrentSpan("output.value", toJsonText(output))

const encodePrompt = Schema.encodeOption(Prompt.Prompt)

const encodeParts = Schema.encodeOption(Schema.Array(AssistantEvent.ModelPart))

type ModelCall = Parameters<Telemetry.SpanTransformer>[0]

const completionOf = (response: ModelCall["response"]) =>
  encodeParts(response.flatMap((part) => Option.toArray(Schema.decodeUnknownOption(AssistantEvent.ModelPart)(part))))

const annotateModelSpan = (
  { span, prompt, response }: ModelCall,
  name: Option.Option<string>,
  attributes: SpanAttributes | undefined
) => {
  span.attribute("gen_ai.prompt", toJsonText(Option.map(encodePrompt(prompt), (encoded) => encoded.content)))
  span.attribute("gen_ai.completion", toJsonText(Option.getOrUndefined(completionOf(response))))

  for (const [key, value] of Object.entries(attributes ?? {})) {
    span.attribute(key, value)
  }

  const finish = response.find((part) => part.type === "finish")

  Telemetry.addGenAIAnnotations(span, {
    operation: { name: "chat" },
    request: { model: Option.getOrUndefined(name) },
    response: { finishReasons: finish === undefined ? undefined : [finish.reason] },
    usage: {
      inputTokens: finish?.usage.inputTokens.total,
      outputTokens: finish?.usage.outputTokens.total
    }
  })

  if (finish?.usage.inputTokens.cacheRead !== undefined) {
    span.attribute("gen_ai.usage.cache_read_input_tokens", finish.usage.inputTokens.cacheRead)
  }

  if (finish?.usage.inputTokens.cacheWrite !== undefined) {
    span.attribute("gen_ai.usage.cache_creation_input_tokens", finish.usage.inputTokens.cacheWrite)
  }
}

/** @internal */
export const annotateModelCall =
  (attributes: SpanAttributes | undefined) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const name = yield* Effect.serviceOption(Model.ModelName)
      const outer = yield* Effect.serviceOption(Telemetry.CurrentSpanTransformer)

      return yield* self.pipe(
        Effect.provideService(Telemetry.CurrentSpanTransformer, (call) => {
          if (Option.isSome(outer)) outer.value(call)

          annotateModelSpan(call, name, attributes)
        })
      )
    })

/** @internal */
export const toolSpan = (call: AssistantEvent.ToolCallPart) =>
  Effect.withSpan(`execute_tool ${call.name}`, {
    kind: "internal",
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": call.name,
      "gen_ai.tool.call.id": call.id,
      "input.value": toJsonText({ arguments: call.params })
    }
  })

/** @internal */
export const toolOutput = (result: Schema.Json) =>
  Effect.annotateCurrentSpan("output.value", Schema.is(Schema.String)(result) ? result : toJsonText(result))
