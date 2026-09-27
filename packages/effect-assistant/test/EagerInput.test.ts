import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { EagerInput } from "../src/index.ts"

const Sent = Schema.fromJsonString(
  Schema.Struct({
    stream: Schema.optional(Schema.Boolean),
    tools: Schema.Array(Schema.Struct({ name: Schema.String, eager_input_streaming: Schema.optional(Schema.Boolean) }))
  })
)

/** What a request sends through `EagerInput.anthropic()`: its tools, and which stream their input. */
const send = (payload: { readonly stream?: boolean }) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make("")

    const client = EagerInput.anthropic()(
      HttpClient.make((request) =>
        Effect.as(
          Ref.set(
            sent,
            Predicate.isTagged(request.body, "Uint8Array") ? new TextDecoder().decode(request.body.body) : ""
          ),
          HttpClientResponse.fromWeb(request, new Response("{}"))
        )
      )
    )

    yield* client.execute(
      HttpClientRequest.post("https://api.anthropic.com/v1/messages").pipe(
        HttpClientRequest.bodyJsonUnsafe({
          model: "claude-sonnet-5",
          ...payload,
          tools: [
            { name: "send_user_message", input_schema: { type: "object" } },
            { name: "search", input_schema: { type: "object" } }
          ]
        })
      )
    )

    const decoded = Schema.decodeSync(Sent)(yield* Ref.get(sent))

    return decoded.tools.map((tool) => [tool.name, tool.eager_input_streaming ?? false])
  })

describe("EagerInput.anthropic", () => {
  it.effect("streams send_user_message's input in a streamed request, and nothing else's", () =>
    Effect.gen(function* () {
      expect(yield* send({ stream: true })).toEqual([
        ["send_user_message", true],
        ["search", false]
      ])
      expect(yield* send({})).toEqual([
        ["send_user_message", false],
        ["search", false]
      ])
    })
  )
})
