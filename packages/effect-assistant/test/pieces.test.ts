import * as Items from "@effect-uai/core/Items"
import * as Loop from "@effect-uai/core/Loop"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Assistant, AssistantChat, AssistantEvent, AssistantHistory, AssistantLoop, ChatId } from "../src/index.ts"
import { collectUntil, newChat, runMemory, say, testModel, turnsDone } from "./fixtures.ts"
import * as Scripted from "./scripted.ts"

class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  throughSeq: Schema.Int,
  text: Schema.String
}) {}

const Compacting = Assistant.make("compacting", { events: [Summary] })

describe("the app's own events", () => {
  it.live("are written with turn.append and read back typed from turn.entries", () =>
    Effect.gen(function* () {
      let seen: ReadonlyArray<Summary> = []

      const handlers = Compacting.toLayer((turn) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* turn.append(Summary.make({ throughSeq: 1, text: "They asked about pens." }))
            const entries = yield* turn.entries
            seen = entries.flatMap(({ event }) => (event instanceof Summary ? [event] : []))
          })
        ).pipe(Stream.drain)
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* Compacting.submit(chat, say("hi"))

        return yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 1)
      }).pipe(
        Effect.provide(
          runMemory(
            handlers,
            Scripted.layer(() => Scripted.reply("Hi."))
          )
        )
      )

      // Stored as a Custom entry, read back as a Summary.
      expect(entries.flatMap(({ event }) => (Predicate.isTagged(event, "Custom") ? [event.name] : []))).toEqual([
        "Summary"
      ])
      expect(seen).toEqual([Summary.make({ throughSeq: 1, text: "They asked about pens." })])
    })
  )
})

describe("AssistantHistory.fromEntries", () => {
  it("puts what comes before first and leaves the app's own events out", () => {
    const chatId = Effect.runSync(ChatId.make)

    const history = AssistantHistory.fromEntries(
      [
        { chatId, seq: 1, at: 0, event: Summary.make({ throughSeq: 0, text: "earlier" }) },
        { chatId, seq: 2, at: 0, event: say("and now?") }
      ],
      { before: [Items.userText("Earlier in this chat: pens.")] }
    )

    expect(history).toEqual([Items.userText("Earlier in this chat: pens."), Items.userText("and now?")])
  })
})

describe("a loop of your own", () => {
  it.live("runs AssistantLoop.step in effect-uai's Loop, and ends with replyIfOwed", () =>
    Effect.gen(function* () {
      const Own = Assistant.make("own-loop")

      const handlers = Own.toLayer((turn) =>
        Loop.loop({ steps: 0 }, (state) =>
          AssistantLoop.step(
            {
              model: testModel,
              instructions: turn.instructions("You help a small team. Be brief."),
              toolkit: turn.tools,
              history: turn.history,
              toolChoice: "required"
            },
            (result) => (result.done || state.steps >= 4 ? Loop.stop() : Loop.next({ steps: state.steps + 1 }))
          )
        ).pipe(Stream.concat(turn.replyIfOwed({ model: testModel, instructions: "You help a small team. Be brief." })))
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* Own.submit(chat, say("Say hi in one short message."))

        return yield* collectUntil(Own, chat, (es) => turnsDone(es) >= 1)
      }).pipe(
        Effect.provide(
          runMemory(
            handlers,
            Scripted.layer(() => Scripted.reply("Hi."))
          )
        )
      )

      expect(AssistantEvent.assistantTexts(entries).length).toBeGreaterThanOrEqual(1)
      expect(entries.flatMap(({ event }) => (AssistantEvent.isTurnEnd(event) ? [event._tag] : []))).toEqual([
        "TurnCompleted"
      ])
    })
  )
})

describe("a history built from turn.entries", () => {
  it.live("moves how far the turn read, like turn.history", () =>
    Effect.gen(function* () {
      const Own = Assistant.make("entries-read")

      const handlers = Own.toLayer((turn) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            // Reads the chat only through entries, then replies.
            yield* turn.entries
            yield* AssistantChat.AssistantChat.use((chat) =>
              chat.append([AssistantEvent.AssistantMessage.make({ id: "r1", text: "Hi." })])
            )
          })
        ).pipe(Stream.drain)
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* Own.submit(chat, say("hello"))

        return yield* collectUntil(Own, chat, (es) => turnsDone(es) >= 1)
      }).pipe(
        Effect.provide(
          runMemory(
            handlers,
            Scripted.layer(() => Scripted.reply("Hi."))
          )
        )
      )

      const end = entries.flatMap(({ event }) => (AssistantEvent.isTurnEnd(event) ? [event] : [])).at(-1)

      // The message was read and answered: the turn read through it, and completed.
      expect(end?._tag).toBe("TurnCompleted")
      expect(end?.throughSeq).toBeGreaterThanOrEqual(2)
    })
  )
})
