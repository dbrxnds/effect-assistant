import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { AssistantEvent, ChatId, ChatLog } from "../src/index.ts"
import { say } from "./utils/fixtures.ts"

// The monorepo has no SQLite driver, so layerSql is tested upstream only.
const stores = { layerMemory: ChatLog.layerMemory }

for (const [name, store] of Object.entries(stores)) {
  describe(`ChatLog.${name}`, () => {
    it.effect("stores and reads a chat's entries, in order", () =>
      Effect.gen(function* () {
        const log = yield* ChatLog.ChatLog
        const chat = yield* ChatId.make
        yield* log.append(chat, [say("one"), AssistantEvent.TurnStarted.make({ assistant: "test" })])

        expect((yield* log.read(chat)).map(({ seq, event }) => [seq, event._tag])).toEqual([
          [1, "UserMessage"],
          [2, "TurnStarted"]
        ])
      }).pipe(Effect.provide(store))
    )
  })
}

describe("ChatLog.layerMemory", () => {
  it.effect("numbers entries per chat from 1", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const [a, b] = yield* Effect.all([ChatId.make, ChatId.make])
      yield* log.append(a, [say("one"), say("two")])
      yield* log.append(b, [say("other")])
      const [third] = yield* log.append(a, [AssistantEvent.TurnStarted.make({ assistant: "test" })])

      expect((yield* log.read(a)).map((entry) => entry.seq)).toEqual([1, 2, 3])
      expect((yield* log.read(b)).map((entry) => entry.seq)).toEqual([1])
      expect(third?.chatId).toBe(a)
      expect(yield* log.append(a, [])).toEqual([])
    }).pipe(Effect.provide(ChatLog.layerMemory))
  )

  it.effect("lists the chats whose last entry doesn't end a turn", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const [done, midTurn, waiting] = yield* Effect.all([ChatId.make, ChatId.make, ChatId.make])
      yield* log.append(done, [
        say("hi"),
        AssistantEvent.TurnStarted.make({ assistant: "test" }),
        AssistantEvent.TurnCompleted.make({ throughSeq: 1 })
      ])
      yield* log.append(midTurn, [say("hi"), AssistantEvent.TurnStarted.make({ assistant: "test" })])
      yield* log.append(waiting, [say("hi")])

      expect([...(yield* log.unfinished)].sort()).toEqual([midTurn, waiting].sort())
    }).pipe(Effect.provide(ChatLog.layerMemory))
  )

  it.effect("reads the entries after a seq", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* ChatId.make
      yield* log.append(chat, [say("one"), say("two"), say("three")])

      expect((yield* log.read(chat, { after: 1 })).map((entry) => entry.seq)).toEqual([2, 3])
      expect(yield* log.read(chat, { after: 3 })).toEqual([])
    }).pipe(Effect.provide(ChatLog.layerMemory))
  )
})
