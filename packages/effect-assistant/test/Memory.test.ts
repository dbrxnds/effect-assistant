import { describe, expect, it } from "@effect/vitest"
import * as Prompt from "effect/ai/Prompt"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { type Assistant, AssistantLoop, ChatId, Memory } from "../src/index.ts"
import { collectUntil, newChat, runMemory, say, TestAssistant, turnsDone } from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const scopes: Memory.Scopes = { personal: "user:1", shared: "team:1" }

/** A handler with memory: what it remembers before the chat, and the memory tools. */
const remembering = Effect.gen(function* () {
  const store = yield* Memory.MemoryStore

  return (turn: Assistant.Turn) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const memory = Memory.render(yield* Memory.facts(scopes), scopes)

        return turn.loop({
          instructions: "Be brief.",
          toolkit: Memory.makeToolkit(scopes),
          history: (entries) => [
            ...Option.toArray(
              Option.map(memory, (text) => Prompt.userMessage({ content: [Prompt.textPart({ text })] }))
            ),
            ...entries
          ]
        })
      })
    ).pipe(Stream.provideService(Memory.MemoryStore, store))
})

const run = (script: Scripted.Script) =>
  Effect.gen(function* () {
    const model = yield* Scripted.make(script)

    const layer = runMemory(TestAssistant.toLayer(remembering), model.layer).pipe(
      Layer.provideMerge(Memory.layerMemory)
    )

    return { model, layer }
  })

/** One chat with one message, until its turn is done. */
const chat = (text: string) =>
  Effect.gen(function* () {
    const chatId = yield* newChat
    yield* TestAssistant.submit(chatId, say(text))

    return yield* collectUntil(TestAssistant, chatId, (entries) => turnsDone(entries) >= 1)
  })

describe("Memory", () => {
  it.live("a later chat reads what an earlier one remembered", () =>
    Effect.gen(function* () {
      const { model, layer } = yield* run((request) => {
        const last = Scripted.lastInput(request)

        if (last.includes("Dutch") && !Scripted.hasCalled(request, "remember")) {
          return [
            Scripted.call("remember", {
              text: "Rotterdam's copy is always Dutch.",
              kind: "profile",
              team: true
            })
          ]
        }

        return Scripted.reply("Noted.")
      })

      yield* Effect.gen(function* () {
        yield* chat("For Rotterdam we always write in Dutch.")
        yield* chat("Write a post for Rotterdam.")
      }).pipe(Effect.provide(layer))

      const requests = yield* model.requests
      const later = requests.at(-1)!

      expect(Scripted.inputs(later)[0]).toMatch(
        /<memory>[\s\S]*About them:\n- \[f-[0-9a-f]{8}\] Rotterdam's copy is always Dutch\. \(team\)/
      )
      expect(later.tools).toEqual(expect.arrayContaining(["remember", "forget", "recall"]))
    })
  )

  it.effect("keeps facts per scope, and forgets only in the scopes it's given", () =>
    Effect.gen(function* () {
      const store = yield* Memory.MemoryStore

      const fact = (id: string, scope: string) =>
        new Memory.Fact({
          id,
          scope,
          kind: "profile",
          text: id,
          chatId: null,
          at: 1,
          expiresAt: null
        })

      yield* store.put(fact("mine", "user:1"))
      yield* store.put(fact("theirs", "user:2"))
      yield* store.put(fact("team", "team:1"))

      const seen = yield* Memory.facts(scopes)
      expect(seen.map((f) => f.id).sort()).toEqual(["mine", "team"])

      expect(yield* store.remove(["user:1", "team:1"], "theirs")).toBe(false)
      expect(yield* store.remove(["user:1", "team:1"], "mine")).toBe(true)
      expect((yield* Memory.facts(scopes)).map((f) => f.id)).toEqual(["team"])
    }).pipe(Effect.provide(Memory.layerMemory))
  )

  it.live("drops notes once they expire, and dates the log", () =>
    Effect.gen(function* () {
      const store = yield* Memory.MemoryStore
      const chatId = yield* ChatId.make
      yield* store.put(
        new Memory.Fact({
          id: "old-note",
          scope: "user:1",
          kind: "note",
          text: "Out of office.",
          chatId: null,
          at: 0,
          expiresAt: 1
        })
      )
      yield* Memory.log(scopes, chatId, "Ordered 25 bags for New York, #1042.")
      yield* Memory.log(scopes, chatId, "Ordered 30 bags for New York, #1042.")

      const facts = yield* Memory.facts(scopes)

      // One line per chat: the second replaced the first.
      expect(facts.map((f) => f.text)).toEqual(["Ordered 30 bags for New York, #1042."])
      expect(Option.getOrThrow(Memory.render(facts, scopes))).toMatch(
        /Earlier chats, newest first:\n- \d{4}-\d{2}-\d{2}: Ordered 30 bags for New York, #1042\./
      )
      expect(Memory.render([], scopes)).toEqual(Option.none())

      // The chat is never shown its own line.
      expect(yield* Memory.facts(scopes, { exceptLogOf: chatId })).toEqual([])
      expect((yield* Memory.facts(scopes, { exceptLogOf: yield* ChatId.make })).length).toBe(1)
    }).pipe(Effect.provide(Memory.layerMemory))
  )

  it.live("forgets by id, and recall finds older facts by their words", () =>
    Effect.gen(function* () {
      const { model, layer } = yield* run((request) => {
        const last = Scripted.lastInput(request)

        if (last.includes("12") && !Scripted.hasCalled(request, "remember")) {
          return [
            Scripted.call("remember", {
              text: "Orders coffee in multiples of 12.",
              kind: "profile"
            })
          ]
        }

        if (last.includes("forget")) {
          const id = /\[(f-[0-9a-f]{8})\]/.exec(Scripted.inputs(request)[0] ?? "")?.[1] ?? ""

          if (!Scripted.hasCalled(request, "forget")) return [Scripted.call("forget", { id })]
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

      expect(recalls[0]).toMatch(/Orders coffee in multiples of 12\. \(profile\)/)
      // After forgetting: nothing left to find, and nothing shown.
      expect(recalls.at(-1)).toBe("[]")
      expect(Scripted.inputs(requests.at(-1)!).some((input) => input.includes("<memory>"))).toBe(false)
    })
  )

  it("merges with other tools", () => {
    const tools = AssistantLoop.merge(AssistantLoop.empty, Memory.makeToolkit(scopes))

    expect(tools.definitions.map((tool) => tool.name)).toEqual(["remember", "forget", "recall"])
  })
})
