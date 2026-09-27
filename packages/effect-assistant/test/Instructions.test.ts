import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { AssistantChat } from "../src/index.ts"
import { memoryAssistant, newChat, say, TestAssistant } from "./fixtures.ts"
import * as Scripted from "./scripted.ts"

describe("a turn's handler", () => {
  it.live("the handler sees the turn's chat, as a service too", () =>
    Effect.gen(function* () {
      const seen = yield* Deferred.make<string>()

      // No model call: the test only needs what the handler was given.
      const layer = memoryAssistant(
        Effect.fn(function* (turn) {
          const service = yield* AssistantChat.AssistantChat
          yield* Deferred.succeed(seen, `${turn.chatId} ${service.chatId}`)

          return Stream.empty
        }),
        Scripted.unused
      )

      const { chatId, got } = yield* Effect.gen(function* () {
        const chatId = yield* newChat
        yield* TestAssistant.submit(chatId, say("hi"))

        return { chatId, got: yield* Deferred.await(seen) }
      }).pipe(Effect.provide(layer))

      expect(got).toBe(`${chatId} ${chatId}`)
    })
  )
})
