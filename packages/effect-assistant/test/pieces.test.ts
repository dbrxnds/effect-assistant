import { describe, expect, it } from "@effect/vitest"
import * as Prompt from "effect/ai/Prompt"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Assistant, AssistantEvent, AssistantLoop, ChatId, ChatLog, CurrentChat, InputId } from "../src/index.ts"
import { collectUntil, failures, newChat, runMemory, say, turnsDone } from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  throughSequence: Schema.Int,
  text: Schema.String,
  at: Schema.Date
}) {}

class FileUploaded extends Schema.TaggedClass<FileUploaded>()("FileUploaded", {
  id: InputId.InputId,
  name: Schema.String
}) {}

const Compacting = Assistant.make("compacting", { events: [Summary, FileUploaded] })

// Not registered with any assistant.
const Unknown = Schema.TaggedStruct("Unknown", { n: Schema.Int })

class DraftOpened extends Schema.TaggedClass<DraftOpened>()("DraftOpened", {
  draftId: Schema.String
}) {}

const Drafting = Assistant.make("drafting", { events: [DraftOpened] })

const note = (text: string) => Prompt.userMessage({ content: [Prompt.textPart({ text })] })

/** The model reads an opened draft as a note, and none of the other app events. */
const draftNotes: Assistant.HistoryView<DraftOpened> = (entries) =>
  entries.map((entry) =>
    entry.event instanceof DraftOpened ? note(`The user opened draft ${entry.event.draftId}.`) : entry
  )

const summary = Summary.make({ throughSequence: 1, text: "They asked about pens.", at: new Date(0) })

describe("the app's own events", () => {
  it.live("are stored as themselves, in JSON, and read back typed", () =>
    Effect.gen(function* () {
      let seen: ReadonlyArray<Summary> = []

      const handlers = Compacting.toLayer(() =>
        Stream.fromEffect(
          Effect.gen(function* () {
            const chat = yield* Compacting.Chat

            yield* chat.append(summary)
            // Typed with the assistant's events: narrowing by tag gives a Summary.
            seen = (yield* chat.entries).flatMap(({ event }) => (Predicate.isTagged(event, "Summary") ? [event] : []))
          })
        ).pipe(Stream.drain)
      )

      const { entries, stored } = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Compacting).submit(chat, say("hi"))
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
      const entry = { chatId: yield* ChatId.make(), sequence: 3, at: 0, event: summary }
      const json = yield* Schema.encodeEffect(Compacting.Entry)(entry)
      const back = yield* Schema.decodeUnknownEffect(Compacting.Entry)(JSON.parse(JSON.stringify(json)))

      expect(back.event).toEqual(summary)
    })
  )

  it.live("one submitted wakes a turn, the model reads it as the view maps it, and it's stored once per id", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(() => Scripted.reply("Got the file."))
      const upload = FileUploaded.make({ id: InputId.fromKey("upload-1"), name: "brief.pdf" })

      const uploads: Assistant.HistoryView<Summary | FileUploaded> = (entries) =>
        entries.map((entry) =>
          entry.event instanceof FileUploaded ? note(`The user uploaded ${entry.event.name}.`) : entry
        )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Compacting).submit(chat, upload)
        yield* (yield* Compacting).submit(chat, upload)

        return yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 1)
      }).pipe(
        Effect.provide(
          runMemory(
            Compacting.toLayer((turn) => turn.run({ instructions: "Be brief.", history: uploads })),
            model.layer
          )
        )
      )

      const [request] = yield* model.requests

      expect(entries.flatMap(({ event }) => (event instanceof FileUploaded ? [event] : []))).toEqual([upload])
      expect(Scripted.inputs(request!)).toEqual(["The user uploaded brief.pdf."])
    })
  )

  it.live("the model doesn't read one no history view maps", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(() => Scripted.reply("Got the file."))

      yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Compacting).submit(chat, say("I'll upload the brief."))
        yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 1)
        yield* (yield* Compacting).submit(
          chat,
          FileUploaded.make({ id: InputId.fromKey("upload-2"), name: "brief.pdf" })
        )
        yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 2)
      }).pipe(
        Effect.provide(
          runMemory(
            Compacting.toLayer((turn) => turn.run({ instructions: "Be brief." })),
            model.layer
          )
        )
      )

      const last = (yield* model.requests).at(-1)

      expect(Scripted.inputs(last!)).toEqual(["I'll upload the brief."])
    })
  )

  it.live("one a turn appends wakes none, and the next turn reads it as the view maps it", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(() => Scripted.reply("On it."))

      const handlers = Drafting.toLayer((turn) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const chat = yield* Drafting.Chat

            if ((yield* chat.entries).every(({ event }) => !(event instanceof DraftOpened)))
              yield* chat.append(DraftOpened.make({ draftId: "d1" }))

            return turn.run({ instructions: "Be brief.", history: draftNotes })
          })
        )
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Drafting).submit(chat, say("open my draft"))
        yield* collectUntil(Drafting, chat, (es) => turnsDone(es) >= 1)
        yield* (yield* Drafting).submit(chat, say("finish it"))

        return yield* collectUntil(Drafting, chat, (es) => turnsDone(es) >= 2)
      }).pipe(Effect.provide(runMemory(handlers, model.layer)))

      const last = (yield* model.requests).at(-1)

      expect(entries.filter(({ event }) => Predicate.isTagged(event, "TurnStarted"))).toHaveLength(2)
      expect(Scripted.inputs(last!)).toEqual(["open my draft", "The user opened draft d1.", "finish it"])
    })
  )

  it.live("a tool its turn runs gets the assistant's typed chat too", () =>
    Effect.gen(function* () {
      const NoteSummary = Tool.make("note_summary", {
        description: "Notes a summary of the chat.",
        success: Schema.String,
        dependencies: [Compacting.Chat]
      })

      const NoteTools = Toolkit.make(NoteSummary)

      const NoteToolsLive = NoteTools.toLayer({
        note_summary: () =>
          Effect.gen(function* () {
            yield* (yield* Compacting.Chat).append(summary)

            return "noted"
          })
      })

      const handlers = Compacting.toLayer((turn) => turn.run({ instructions: "Be brief.", toolkit: NoteTools })).pipe(
        Layer.provide(NoteToolsLive)
      )

      const model = Scripted.layer((request) =>
        Scripted.hasCalled(request, "note_summary") ? Scripted.reply("Noted.") : [Scripted.call("note_summary")]
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Compacting).submit(chat, say("note it"))

        return yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(runMemory(handlers, model)))

      expect(entries.flatMap(({ event }) => (event instanceof Summary ? [event] : []))).toEqual([summary])
    })
  )

  it.live("the chat stores no app event its assistant didn't register", () =>
    Effect.gen(function* () {
      const other = yield* Schema.decodeUnknownEffect(AssistantEvent.StoredAppEvent)(Unknown.make({ n: 1 }))

      const handlers = Drafting.toLayer(() =>
        Stream.fromEffect(CurrentChat.CurrentChat.use((chat) => chat.append(other))).pipe(Stream.drain)
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Drafting).submit(chat, say("hi"))
        yield* collectUntil(Drafting, chat, (es) => turnsDone(es) >= 1)

        return yield* ChatLog.ChatLog.use((log) => log.read(chat))
      }).pipe(Effect.provide(runMemory(handlers, Scripted.unused)))

      expect(entries.map(({ event }) => event._tag)).toEqual(["UserMessage", "TurnStarted", "TurnFailed"])
      expect(failures(entries)[0]).toContain("Unknown isn't one of the drafting assistant's events")
    })
  )

  it.live("a history view picks what the model reads: here, the summary and what came after it", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(() => Scripted.reply("Pens it is."))

      const sinceSummary: Assistant.HistoryView<Summary | FileUploaded> = (entries) => {
        const last = entries.findLast(({ event }) => event instanceof Summary)

        return last === undefined || !(last.event instanceof Summary)
          ? entries
          : [
              ...Prompt.make(`Earlier in this chat: ${last.event.text}`).content,
              ...entries.filter(({ sequence }) => sequence > last.sequence)
            ]
      }

      const handlers = Compacting.toLayer((turn) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // The first turn writes the summary; the second reads through the view.
            if ((yield* (yield* CurrentChat.CurrentChat).entries).every(({ event }) => !(event instanceof Summary)))
              yield* (yield* CurrentChat.CurrentChat).append(summary)

            return turn.run({ instructions: "Be brief.", history: sinceSummary })
          })
        )
      )

      yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Compacting).submit(chat, say("pens?"))
        yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 1)
        yield* (yield* Compacting).submit(chat, say("and now?"))
        yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 2)
      }).pipe(Effect.provide(runMemory(handlers, model.layer)))

      const last = (yield* model.requests).at(-1)

      expect(Scripted.inputs(last!)).toEqual(["Earlier in this chat: They asked about pens.", "and now?"])
    })
  )
})

describe("a loop of your own", () => {
  it.live("runs AssistantLoop.step in AssistantLoop.loop, and ends with replyIfOwed", () =>
    Effect.gen(function* () {
      const Own = Assistant.make("own-loop")

      const handlers = Own.toLayer((turn) =>
        AssistantLoop.loop({ steps: 0 }, (state) =>
          AssistantLoop.step(
            {
              instructions: turn.instructions("You help a small team. Be brief."),
              history: turn.history(),
              toolChoice: "required"
            },
            (result) =>
              result.done || state.steps >= 4 ? AssistantLoop.stop() : AssistantLoop.next({ steps: state.steps + 1 })
          )
        ).pipe(Stream.concat(turn.replyIfOwed({ instructions: "You help a small team. Be brief." })))
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Own).submit(chat, say("Say hi in one short message."))

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

      const handlers = Own.toLayer(() =>
        Stream.fromEffect(
          Effect.gen(function* () {
            // Reads the chat only through entries, then replies.
            yield* (yield* CurrentChat.CurrentChat).entries
            yield* CurrentChat.CurrentChat.use((chat) =>
              chat.append(AssistantEvent.AssistantMessage.make({ id: "r1", text: "Hi." }))
            )
          })
        ).pipe(Stream.drain)
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Own).submit(chat, say("hello"))

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
      expect(end?.throughSequence).toBeGreaterThanOrEqual(2)
    })
  )
})

describe("Assistant.isAssistant", () => {
  it("is true for a definition and false for anything else", () => {
    expect(Assistant.isAssistant(Assistant.make("guarded"))).toBe(true)
    expect(Assistant.isAssistant({ name: "guarded" })).toBe(false)
    expect(Assistant.isAssistant(undefined)).toBe(false)
  })
})
