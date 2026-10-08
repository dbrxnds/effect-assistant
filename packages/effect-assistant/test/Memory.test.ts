import { describe, expect, it } from "@effect/vitest"
import * as Toolkit from "effect/ai/Toolkit"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { type Assistant, ChatId, Memory } from "../src/index.ts"
import { collectUntil, newChat, runMemory, say, TestAssistant, turnsDone } from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

/** A handler with memory: the chat's facts in its instructions, and the memory tools. */
const remembering = Effect.gen(function* () {
  const store = yield* Memory.MemoryStore

  return (turn: Assistant.Turn) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const facts = yield* store.facts(turn.chatId)

        return turn.loop({ instructions: `Be brief.\n\n${Memory.render(facts)}`, toolkit: Memory.Tools })
      })
    ).pipe(Stream.provideService(Memory.MemoryStore, store))
})

const run = (script: Scripted.Script) =>
  Effect.gen(function* () {
    const model = yield* Scripted.make(script)

    const layer = runMemory(
      TestAssistant.toLayer(remembering).pipe(Layer.provide(Memory.layerTools)),
      model.layer
    ).pipe(Layer.provideMerge(Memory.layerMemory))

    return { model, layer }
  })

/** One chat with one message, until its turn is done. */
const chat = (text: string) =>
  Effect.gen(function* () {
    const chatId = yield* newChat
    yield* (yield* TestAssistant).submit(chatId, say(text))

    return yield* collectUntil(TestAssistant, chatId, (entries) => turnsDone(entries) >= 1)
  })

const endOfDay = (date: string) => Option.getOrThrow(DateTime.make(`${date}T23:59:59Z`))

describe("Memory", () => {
  it.live("a later chat is told what an earlier one remembered", () =>
    Effect.gen(function* () {
      const { model, layer } = yield* run((request) =>
        Scripted.lastInput(request).includes("Dutch") && !Scripted.hasCalled(request, "remember")
          ? [Scripted.call("remember", { text: "Rotterdam's copy is always Dutch." })]
          : Scripted.reply("Noted.")
      )

      yield* Effect.gen(function* () {
        yield* chat("For Rotterdam we always write in Dutch.")
        yield* chat("Write a post for Rotterdam.")
      }).pipe(Effect.provide(layer))

      const later = (yield* model.requests).at(-1)!

      expect(later.system).toMatch(/<memory>[\s\S]*- \[f-[0-9a-f]{8}\] Rotterdam's copy is always Dutch\./)
      expect(later.tools).toEqual(expect.arrayContaining(["remember", "forget", "recall"]))
    })
  )

  it.live("forgets by id, and recall finds facts by their words", () =>
    Effect.gen(function* () {
      const { model, layer } = yield* run((request) => {
        const last = Scripted.lastInput(request)

        if (last.includes("12") && !Scripted.hasCalled(request, "remember")) {
          return [Scripted.call("remember", { text: "Orders coffee in multiples of 12." })]
        }

        if (last.includes("forget") && !Scripted.hasCalled(request, "forget")) {
          const id = /\[(f-[0-9a-f]{8})\]/.exec(request.system)?.[1] ?? ""

          return [Scripted.call("forget", { id })]
        }

        if (last.includes("coffee") && !Scripted.hasCalled(request, "recall")) {
          return [Scripted.call("recall", { query: "coffee multiples" })]
        }

        return Scripted.reply("Done.")
      })

      yield* Effect.gen(function* () {
        yield* chat("I always order in 12s.")
        yield* chat("What do you know about my coffee?")
        yield* chat("Please forget that.")
        yield* chat("And now, about my coffee?")
      }).pipe(Effect.provide(layer))

      const requests = yield* model.requests
      const recalls = requests.flatMap((request) => Option.toArray(Scripted.lastResult(request, "recall")))

      expect(recalls[0]).toMatch(/Orders coffee in multiples of 12\./)
      // After forgetting: nothing left to find, and nothing shown.
      expect(recalls.at(-1)).toBe("[]")
      expect(requests.at(-1)!.system).not.toContain("<memory>")
    })
  )

  it.live("keeps a short-lived fact until its day, and refuses a date it can't read", () =>
    Effect.gen(function* () {
      const { model, layer } = yield* run((request) => {
        const last = Scripted.lastInput(request)

        if (last.includes("Friday") && !Scripted.hasCalled(request, "remember")) {
          return [Scripted.call("remember", { text: "Out of office until Friday.", until: "2999-01-02" })]
        }

        if (last.includes("soon") && !Scripted.hasCalled(request, "remember")) {
          return [Scripted.call("remember", { text: "Back soon.", until: "next week" })]
        }

        return Scripted.reply("Noted.")
      })

      yield* Effect.gen(function* () {
        yield* chat("I'm out until Friday.")
        yield* chat("I'll be back soon.")
      }).pipe(Effect.provide(layer))

      const requests = yield* model.requests

      expect(requests.at(-1)!.system).toContain("Out of office until Friday. (until 2999-01-02)")
      expect(Option.getOrUndefined(Scripted.lastResult(requests.at(-1)!, "remember"))).toContain(
        "until must be a date as YYYY-MM-DD"
      )
    })
  )

  it.live("the in-memory store drops expired facts, replaces by id, and fails to forget what it doesn't have", () =>
    Effect.gen(function* () {
      const store = yield* Memory.MemoryStore
      const chatId = yield* ChatId.make()

      yield* store.remember(chatId, { text: "Gone.", expiresAt: endOfDay("2000-01-01") })
      const old = yield* store.remember(chatId, { text: "Prefers email." })
      yield* store.remember(chatId, { text: "Prefers phone calls.", replaces: old })

      expect((yield* store.facts(chatId)).map((fact) => fact.text)).toEqual(["Prefers phone calls."])
      expect(Exit.isFailure(yield* Effect.exit(store.forget(chatId, "f-missing")))).toBe(true)
      expect(Memory.render([])).toBe("")
    }).pipe(Effect.provide(Memory.layerMemory))
  )

  it("is a native toolkit, to merge with the app's", () => {
    expect(Object.keys(Toolkit.merge(Memory.Tools, Toolkit.make()).tools)).toEqual(["remember", "forget", "recall"])
  })
})
