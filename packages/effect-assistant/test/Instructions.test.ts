import { describe, expect, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { AssistantTurn, Instructions } from "../src/index.ts"
import { memoryAssistant, newChat, say, TestAssistant } from "./fixtures.ts"

class Version extends Context.Service<Version, { readonly current: number }>()("test/Version") {}

describe("Instructions.resolve", () => {
  it.effect("resolves text, an Effect of text, and an Effect with attributes", () =>
    Effect.gen(function*() {
      expect(yield* Instructions.resolve("Be brief.")).toEqual({ text: "Be brief." })
      expect(yield* Instructions.resolve(Effect.succeed("From a service."))).toEqual({ text: "From a service." })

      const managed = Effect.gen(function*() {
        const version = yield* Version

        return { text: "Managed.", attributes: { "prompt.version": version.current } }
      })

      expect(yield* Instructions.resolve(managed).pipe(Effect.provideService(Version, { current: 3 }))).toEqual({
        text: "Managed.",
        attributes: { "prompt.version": 3 }
      })
    }))

  it.live("the handler sees the turn's chat, as a service too", () =>
    Effect.gen(function*() {
      const seen = yield* Deferred.make<string>()

      // No model call: the test only needs what the handler was given.
      const layer = memoryAssistant(Effect.fn(function*(turn) {
        const service = yield* AssistantTurn.AssistantTurn
        yield* Deferred.succeed(seen, `${turn.chatId} ${service.chatId}`)

        return Stream.empty
      }))

      const [chatId, got] = yield* Effect.gen(function*() {
        const chatId = yield* newChat()
        yield* TestAssistant.submit(chatId, say("hi"))

        return [chatId, yield* Deferred.await(seen)] as const
      }).pipe(Effect.provide(layer))

      expect(got).toBe(`${chatId} ${chatId}`)
    }))
})
