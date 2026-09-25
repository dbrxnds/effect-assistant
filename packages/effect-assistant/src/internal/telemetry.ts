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
 * The standard `gen_ai.*` attributes come from Effect's `Telemetry` module.
 * Message content is always attached; drop or mask it in the exporter.
 *
 * @since 0.1.0
 * @internal
 */
import type * as Items from "@effect-uai/core/Items"
import type * as Turn from "@effect-uai/core/Turn"
import * as Effect from "effect/Effect"
import * as Telemetry from "effect/unstable/ai/Telemetry"
import type * as AssistantEvent from "../AssistantEvent.ts"
import type { SpanAttributes } from "../Instructions.ts"

/** What the spans record: model history, chat events, or text. */
type Traced = string | ReadonlyArray<Items.HistoryItem> | ReadonlyArray<AssistantEvent.AssistantEvent>

const json = (value: Traced): string => JSON.stringify(value)

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
 * Sets the agent's input on the current span.
 *
 * @internal
 */
export const agentInput = (input: Traced) => Effect.annotateCurrentSpan("input.value", json(input))

/**
 * Sets the agent's output on the current span.
 *
 * @internal
 */
export const agentOutput = (output: Traced) => Effect.annotateCurrentSpan("output.value", json(output))

/**
 * Wraps one model call in a `chat` span, with its input, output, and usage.
 *
 * @internal
 */
export const chatSpan = (
  model: string,
  input: ReadonlyArray<Items.HistoryItem>,
  attributes: SpanAttributes | undefined
) =>
<E, R>(self: Effect.Effect<Turn.Turn, E, R>): Effect.Effect<Turn.Turn, E, R> =>
  self.pipe(
    Effect.tap((turn) =>
      Effect.currentSpan.pipe(
        Effect.tap((span) =>
          Effect.sync(() => {
            Telemetry.addGenAIAnnotations(span, {
              operation: { name: "chat" },
              request: { model },
              response: { finishReasons: [turn.stop_reason] },
              usage: { inputTokens: turn.usage.input_tokens, outputTokens: turn.usage.output_tokens }
            })
            span.attribute("gen_ai.completion", json(turn.items))
            const details = turn.usage.input_tokens_details

            if (details?.cached_tokens !== undefined) {
              span.attribute("gen_ai.usage.cache_read_input_tokens", details.cached_tokens)
            }

            if (details?.cache_write_tokens !== undefined) {
              span.attribute("gen_ai.usage.cache_creation_input_tokens", details.cache_write_tokens)
            }
          })
        ),
        Effect.ignore
      )
    ),
    Effect.withSpan(`chat ${model}`, {
      kind: "client",
      attributes: { "gen_ai.prompt": json(input), ...attributes }
    })
  )

/**
 * Wraps one tool call in an `execute_tool` span.
 *
 * The input is wrapped as `{ arguments }`, so viewers don't mistake arguments
 * like `{ text }` for a chat message.
 *
 * @internal
 */
export const toolSpan = (call: Items.ToolCall) =>
  Effect.withSpan(`execute_tool ${call.name}`, {
    kind: "internal",
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": call.name,
      "gen_ai.tool.call.id": call.call_id,
      "input.value": `{"arguments":${isJson(call.arguments) ? call.arguments : JSON.stringify(call.arguments)}}`
    }
  })

const isJson = (raw: string): boolean => {
  try {
    JSON.parse(raw)

    return true
  } catch {
    return false
  }
}

/**
 * Sets a tool's output on the current span.
 *
 * @internal
 */
export const toolOutput = (output: string) => Effect.annotateCurrentSpan("output.value", output)
