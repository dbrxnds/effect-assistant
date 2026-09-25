import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { AssistantEvent, ChatId, ChatLog } from "../src/index.ts"
import { say } from "./fixtures.ts"

describe("ChatLog.layerMemory", () => {
  it.effect("numbers entries per chat from 1", () =>
    Effect.gen(function*() {
      const log = yield* ChatLog.ChatLog
      const [a, b] = [ChatId.make(), ChatId.make()]
      yield* log.append(a, [say("one"), say("two")])
      yield* log.append(b, [say("other")])
      const [third] = yield* log.append(a, [AssistantEvent.TurnStarted.make({})])

      expect((yield* log.read(a)).map((entry) => entry.seq)).toEqual([1, 2, 3])
      expect((yield* log.read(b)).map((entry) => entry.seq)).toEqual([1])
      expect(third?.chatId).toBe(a)
      expect(yield* log.append(a, [])).toEqual([])
    }).pipe(Effect.provide(ChatLog.layerMemory)))

  it.effect("lists the chats whose last entry doesn't end a turn", () =>
    Effect.gen(function*() {
      const log = yield* ChatLog.ChatLog
      const [done, midTurn, waiting] = [ChatId.make(), ChatId.make(), ChatId.make()]
      yield* log.append(done, [
        say("hi"),
        AssistantEvent.TurnStarted.make({}),
        AssistantEvent.TurnCompleted.make({ throughSeq: 1 })
      ])
      yield* log.append(midTurn, [say("hi"), AssistantEvent.TurnStarted.make({})])
      yield* log.append(waiting, [say("hi")])

      expect([...(yield* log.unfinished)].sort()).toEqual([midTurn, waiting].sort())
    }).pipe(Effect.provide(ChatLog.layerMemory)))
})
