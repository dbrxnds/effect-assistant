/**
 * A model call's streamed response, read into the parts a whole response has,
 * and the message the assistant composes while it streams.
 *
 * @since 0.1.0
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as AiError from "effect/unstable/ai/AiError"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Response from "effect/unstable/ai/Response"
import type * as Tool from "effect/unstable/ai/Tool"
import * as AssistantEvent from "../AssistantEvent.ts"
import { Composer, partialText } from "./composing.ts"
import { toJsonText } from "./schema.ts"
import { sendUserMessageName } from "./tools.ts"

type Tools = Record<string, Tool.Any>

/** Text or reasoning the model is writing, by its stream id. */
interface Open {
  readonly type: "text" | "reasoning"
  text: string
  metadata: Response.ProviderMetadata
}

const failed = (part: Response.ErrorPart) =>
  AiError.make({
    module: "AssistantLoop",
    method: "step",
    reason: new AiError.InternalProviderError({ description: toJsonText(part.error) || "The response stream failed" })
  })

/**
 * Reads a model call's stream into the response `generateText` would have
 * returned: text and reasoning whole, each at its end, with its metadata
 * (a later part's replaces an earlier one's, per provider), and the other
 * parts as they came. While a `send_user_message` call's params stream, the
 * text they have so far goes to the chat as `Composing`. An error part fails
 * the call, like an error response.
 *
 * @internal
 */
export const collect = <E, R>(
  stream: Stream.Stream<Response.StreamPart<Tools, "opaque">, E, R>
): Effect.Effect<LanguageModel.GenerateTextResponse<Tools, "opaque">, E | AiError.AiError, R> =>
  Effect.gen(function* () {
    const compose = yield* Composer
    const parts: Array<Response.Part<Tools, "opaque">> = []
    const open = new Map<string, Open>()
    // The params of the `send_user_message` calls the model is writing, by call id.
    const messages = new Map<string, string>()

    const write = (part: Response.StreamPart<Tools, "opaque">): Effect.Effect<void, AiError.AiError> => {
      switch (part.type) {
        case "text-start":
        case "reasoning-start": {
          open.set(part.id, {
            type: part.type === "text-start" ? "text" : "reasoning",
            text: "",
            metadata: part.metadata
          })

          return Effect.void
        }

        case "text-delta":
        case "reasoning-delta": {
          const active = open.get(part.id)

          if (active !== undefined) {
            active.text += part.delta
            active.metadata = { ...active.metadata, ...part.metadata }
          }

          return Effect.void
        }

        case "text-end":
        case "reasoning-end": {
          const active = open.get(part.id)

          if (active !== undefined) {
            const metadata = { ...active.metadata, ...part.metadata }

            parts.push(
              active.type === "text"
                ? Response.makePart("text", { text: active.text, metadata })
                : Response.makePart("reasoning", { text: active.text, metadata })
            )
            open.delete(part.id)
          }

          return Effect.void
        }

        case "tool-params-start": {
          if (part.name !== sendUserMessageName) return Effect.void

          messages.set(part.id, "")

          return compose(AssistantEvent.Composing.make({ text: "" }))
        }

        case "tool-params-delta": {
          const params = messages.get(part.id)

          if (params === undefined) return Effect.void

          messages.set(part.id, params + part.delta)

          return compose(AssistantEvent.Composing.make({ text: partialText(params + part.delta) ?? "" }))
        }

        case "tool-params-end":
          return Effect.void

        case "error":
          return Effect.fail(failed(part))

        default: {
          parts.push(part)

          return Effect.void
        }
      }
    }

    yield* Stream.runForEach(stream, write)

    return new LanguageModel.GenerateTextResponse<Tools, "opaque">(parts)
  })
