/**
 * Spans in the OpenTelemetry GenAI conventions, so LLM tools (Langfuse,
 * Phoenix, Datadog LLM Observability) can pick the agent work out of a trace:
 *
 * ```
 * invoke_agent <assistant>          one trace per turn; session = chat id
 * ├─ chat <model>             messages in and out, token usage, finish reason
 * ├─ execute_tool <name>      arguments and result
 * └─ invoke_agent <specialist>
 * ```
 *
 * The standard `gen_ai.*` attributes come from Effect's `Telemetry` module;
 * the `LanguageModel` call adds its own span inside `chat`, with the
 * provider's attributes.
 * Message content is always attached; drop or mask it in the exporter.
 *
 * @since 0.1.0
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Model from "effect/unstable/ai/Model"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Telemetry from "effect/unstable/ai/Telemetry"
import type * as Tool from "effect/unstable/ai/Tool"
import * as AssistantEvent from "../AssistantEvent.ts"
import type { SpanAttributes } from "../Instructions.ts"
import { toJsonText } from "./schema.ts"

/** What the spans record: chat events, or text. */
type Traced = string | ReadonlyArray<{ readonly _tag: string }>

/**
 * Wraps a turn or a specialist run in an `invoke_agent` span.
 *
 * @internal
 */
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

/**
 * The current trace's id, when a tracer records it: none when tracing is
 * off, or when the tracer is Effect's own, which exports nothing.
 *
 * @internal
 */
export const currentTraceId: Effect.Effect<Option.Option<string>> = Effect.gen(function* () {
  const tracer = yield* Tracer.Tracer

  if (!(yield* References.TracerEnabled) || tracer === Tracer.nativeTracer) return Option.none()

  return Option.map(yield* Effect.option(Effect.currentSpan), (span) => span.traceId)
})

/**
 * Sets the agent's input on the current span.
 *
 * @internal
 */
export const agentInput = (input: Traced) => Effect.annotateCurrentSpan("input.value", toJsonText(input))

/**
 * Sets the agent's output on the current span.
 *
 * @internal
 */
export const agentOutput = (output: Traced) => Effect.annotateCurrentSpan("output.value", toJsonText(output))

const encodePrompt = Schema.encodeOption(Prompt.Prompt)

const encodeParts = Schema.encodeOption(Schema.Array(AssistantEvent.ModelPart))

/**
 * Wraps one model call in a `chat` span, with its input, output, and usage.
 * The span is named after the model when the context has its name
 * (`AnthropicLanguageModel.model(...)` provides it).
 *
 * @internal
 */
export const chatSpan =
  (prompt: Prompt.Prompt, attributes: SpanAttributes | undefined) =>
  <Tools extends Record<string, Tool.Any>, E, R>(
    self: Effect.Effect<LanguageModel.GenerateTextResponse<Tools, "opaque">, E, R>
  ): Effect.Effect<LanguageModel.GenerateTextResponse<Tools, "opaque">, E, R> =>
    Effect.flatMap(Effect.serviceOption(Model.ModelName), (name) =>
      self.pipe(
        Effect.tap((response) =>
          Effect.currentSpan.pipe(
            Effect.tap((span) =>
              Effect.sync(() => {
                const { usage } = response

                Telemetry.addGenAIAnnotations(span, {
                  operation: { name: "chat" },
                  request: { model: Option.getOrUndefined(name) },
                  response: { finishReasons: [response.finishReason] },
                  usage: { inputTokens: usage.inputTokens.total, outputTokens: usage.outputTokens.total }
                })

                const completion = encodeParts(
                  response.content.flatMap((part) =>
                    Option.toArray(Schema.decodeUnknownOption(AssistantEvent.ModelPart)(part))
                  )
                )

                span.attribute("gen_ai.completion", toJsonText(Option.getOrUndefined(completion)))

                if (usage.inputTokens.cacheRead !== undefined) {
                  span.attribute("gen_ai.usage.cache_read_input_tokens", usage.inputTokens.cacheRead)
                }

                if (usage.inputTokens.cacheWrite !== undefined) {
                  span.attribute("gen_ai.usage.cache_creation_input_tokens", usage.inputTokens.cacheWrite)
                }
              })
            ),
            Effect.ignore
          )
        ),
        Effect.withSpan(Option.match(name, { onNone: () => "chat", onSome: (model) => `chat ${model}` }), {
          kind: "client",
          attributes: {
            "gen_ai.prompt": toJsonText(Option.map(encodePrompt(prompt), (encoded) => encoded.content)),
            ...attributes
          }
        })
      )
    )

/**
 * Wraps one tool call in an `execute_tool` span.
 *
 * The input is wrapped as `{ arguments }`, so viewers don't mistake arguments
 * like `{ text }` for a chat message.
 *
 * @internal
 */
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

/**
 * Sets a tool's result on the current span.
 *
 * @internal
 */
export const toolOutput = (result: Schema.Json) =>
  Effect.annotateCurrentSpan("output.value", Schema.is(Schema.String)(result) ? result : toJsonText(result))
