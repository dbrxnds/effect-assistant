import * as Items from "@effect-uai/core/Items"
import * as Loop from "@effect-uai/core/Loop"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Assistant, AssistantChat, AssistantEvent, AssistantLoop, ChatId, ChatLog, InputId } from "../src/index.ts"
import { collectUntil, newChat, runMemory, say, testModel, turnsDone } from "./fixtures.ts"
import * as Scripted from "./scripted.ts"

class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  throughSeq: Schema.Int,
  text: Schema.String,
  at: Schema.Date
}) {}

class FileUploaded extends Schema.TaggedClass<FileUploaded>()("FileUploaded", {
  id: InputId.InputId,
  name: Schema.String
}) {}

const Compacting = Assistant.make("compacting", { events: [Summary], inputs: [FileUploaded] })

const summary = Summary.make({ throughSeq: 1, text: "They asked about pens.", at: new Date(0) })

describe("the app's own events", () => {
  it.live("are stored as themselves, in JSON, and read back typed", () =>
    Effect.gen(function* () {
      let seen: ReadonlyArray<Summary> = []

      const handlers = Compacting.toLayer((turn) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* turn.append(summary)
            seen = (yield* turn.entries).flatMap(({ event }) => (event instanceof Summary ? [event] : []))
          })
        ).pipe(Stream.drain)
      )

      const { entries, stored } = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* Compacting.submit(chat, say("hi"))
        const entries = yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 1)

        return { entries, stored: yield* ChatLog.ChatLog.use((log) => log.read(chat)) }
      }).pipe(Effect.provide(runMemory(handlers, Scripted.unused)))

      // Stored as the event itself, with its Date in JSON; read back (by the turn and by subscribe) as a Summary.
      const json = yield* Schema.encodeEffect(Schema.toCodecJson(Summary))(summary)

      expect(stored.flatMap(({ event }) => (AssistantEvent.isLibraryEvent(event) ? [] : [event]))).toEqual([json])
      expect(JSON.stringify(json)).toContain('"at":"1970-01-01T00:00:00.000Z"')
      expect(seen).toEqual([summary])
      expect(entries.flatMap(({ event }) => (event instanceof Summary ? [event] : []))).toEqual([summary])
    })
  )

  it.effect("MyAssistant.Entry takes an entry with an app event through JSON and back, for an RPC", () =>
    Effect.gen(function* () {
      const entry = { chatId: yield* ChatId.make, seq: 3, at: 0, event: summary }
      const json = yield* Schema.encodeEffect(Compacting.Entry)(entry)
      const back = yield* Schema.decodeUnknownEffect(Compacting.Entry)(JSON.parse(JSON.stringify(json)))

      expect(back.event).toEqual(summary)
    })
  )

  it.live("an input wakes a turn, the model reads it, and it's stored once per id", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(() => Scripted.reply("Got the file."))
      const upload = FileUploaded.make({ id: InputId.fromKey("upload-1"), name: "brief.pdf" })

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* Compacting.submit(chat, upload)
        yield* Compacting.submit(chat, upload)

        return yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 1)
      }).pipe(
        Effect.provide(
          runMemory(
            Compacting.toLayer((turn) => turn.loop({ model: testModel, instructions: "Be brief." })),
            model.layer
          )
        )
      )

      const [request] = yield* model.requests

      expect(entries.flatMap(({ event }) => (event instanceof FileUploaded ? [event] : []))).toEqual([upload])
      expect(Scripted.lastInput(request!)).toBe('<FileUploaded>\n{"id":"upload-1","name":"brief.pdf"}\n</FileUploaded>')
    })
  )

  it.live("a history view picks what the model reads: here, the summary and what came after it", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(() => Scripted.reply("Pens it is."))

      const sinceSummary: Assistant.HistoryView<Summary | FileUploaded> = (entries) => {
        const last = entries.findLast(({ event }) => event instanceof Summary)

        return last === undefined || !(last.event instanceof Summary)
          ? entries
          : [Items.userText(`Earlier in this chat: ${last.event.text}`), ...entries.filter(({ seq }) => seq > last.seq)]
      }

      const handlers = Compacting.toLayer((turn) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // The first turn writes the summary; the second reads through the view.
            if ((yield* turn.entries).every(({ event }) => !(event instanceof Summary))) yield* turn.append(summary)

            return turn.loop({ model: testModel, instructions: "Be brief.", history: sinceSummary })
          })
        )
      )

      yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* Compacting.submit(chat, say("pens?"))
        yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 1)
        yield* Compacting.submit(chat, say("and now?"))
        yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 2)
      }).pipe(Effect.provide(runMemory(handlers, model.layer)))

      const last = (yield* model.requests).at(-1)

      expect(Scripted.inputs(last!)).toEqual(["Earlier in this chat: They asked about pens.", "and now?"])
    })
  )
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
              history: turn.history(),
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
