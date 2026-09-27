/**
 * The `EagerInput` module has a provider stream a tool call's params as the
 * model writes them, rather than all at once when the call is complete. The
 * loop streams every model call, and while the model writes a
 * `send_user_message` call, the chat's view has the message's text so far
 * (`ChatView.Activity`'s `composing`). Without eager input, a provider may
 * hold a call's params back until they're whole: the chat shows that the
 * assistant is writing, and the text arrives at once.
 *
 * **Anthropic**
 *
 * Anthropic streams a tool's input as it's written with
 * `eager_input_streaming: true` on the tool's definition. `@effect/ai-anthropic`
 * has no option for it, so {@link anthropic} sets it on the request: give it
 * to the client's `transformClient`. The API then no longer checks the input
 * against the tool's schema; the loop still does, and a call whose params
 * don't fit fails, and the model reads why.
 *
 * **Example** (Messages streamed as they're written, with Anthropic)
 *
 * ```ts
 * import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
 * import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"
 * import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
 * import { EagerInput } from "effect-assistant"
 *
 * const ModelLive = AnthropicLanguageModel.model("claude-sonnet-5").pipe(
 *   Layer.provide(AnthropicClient.layer({ apiKey, transformClient: EagerInput.anthropic() })),
 *   Layer.provide(FetchHttpClient.layer)
 * )
 * ```
 *
 * @since 0.1.0
 */
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { sendUserMessageName } from "./internal/tools.ts"

/**
 * The tools whose params the chat reads while they stream: the assistant's
 * `send_user_message`.
 *
 * @category constants
 * @since 0.1.0
 */
export const composingTools: ReadonlyArray<string> = [sendUserMessageName]

// A streamed Messages request with tools, and the rest of it as it is.
const MessagesRequest = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      stream: Schema.Literal(true),
      tools: Schema.Array(
        Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [Schema.Record(Schema.String, Schema.Json)])
      )
    }),
    [Schema.Record(Schema.String, Schema.Json)]
  )
)

const decodeRequest = Schema.decodeOption(MessagesRequest)

const encodeRequest = Schema.encodeOption(MessagesRequest)

/**
 * Returns a `transformClient` for `@effect/ai-anthropic`'s `AnthropicClient`
 * that streams these tools' input as the model writes it: it sets
 * `eager_input_streaming: true` on their definitions in each streamed
 * Messages request. Default: {@link composingTools}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const anthropic =
  (tools: ReadonlyArray<string> = composingTools) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(client, (request) => {
      const { body } = request

      if (!request.url.endsWith("/v1/messages") || !Predicate.isTagged(body, "Uint8Array")) return request

      const eager = decodeRequest(new TextDecoder().decode(body.body)).pipe(
        Option.map((payload) => ({
          ...payload,
          tools: payload.tools.map((tool) =>
            tools.includes(tool.name) ? { ...tool, eager_input_streaming: true } : tool
          )
        })),
        Option.flatMap(encodeRequest)
      )

      return Option.match(eager, {
        onNone: () => request,
        onSome: (json) => HttpClientRequest.bodyText(request, json, body.contentType)
      })
    })
