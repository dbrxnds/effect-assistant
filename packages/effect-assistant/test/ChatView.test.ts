import { describe, expect, it } from "@effect/vitest"
import * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { AssistantEvent, ChatId, ChatView, InputId, RunId } from "../src/index.ts"
import {
  collectUntil,
  newChat,
  readUpdates,
  say,
  storedUpdate,
  submittedUpdate,
  turnsDone,
  Update,
  update,
  Updating,
  updatingAssistant
} from "./utils/fixtures.ts"
import * as AppEvents from "../src/internal/events.ts"
import * as Scripted from "./utils/scripted.ts"

const chatId = Effect.runSync(ChatId.make())

const entries = (events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>) =>
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: (i + 1) * 1000, event }))

const view = (events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>) =>
  ChatView.fromEntries(entries(events))

const hi = AssistantEvent.UserMessage.make({ id: InputId.fromKey("hi"), text: "Order 300 totes" })

const call = Response.makePart("tool-call", {
  id: "toolu_quote",
  name: "quote_order",
  params: { sku: "tote", quantity: 300 },
  providerExecuted: false
})

const ask = AssistantEvent.AssistantMessage.make({
  id: "m1",
  text: "That's $1,200. Which color?",
  block: AssistantEvent.MessageBlock.make({
    kind: "choose_one",
    props: { options: ["red", "blue"] }
  })
})

const pick = AssistantEvent.BlockAnswer.make({
  id: InputId.fromKey("m1:answer"),
  messageId: "m1",
  kind: "choose_one",
  value: { choice: "blue" }
})

/** A turn that quotes an order and asks which color, and the user picks one. */
const quoting = [
  hi,
  AssistantEvent.TurnStarted.make({ assistant: "test" }),
  AssistantEvent.ModelOutput.make({ parts: [call], seenThroughSeq: 2 }),
  AssistantEvent.ToolStarted.make({ callId: "toolu_quote", tool: "quote_order" }),
  AssistantEvent.ToolResult.make({
    callId: "toolu_quote",
    tool: "quote_order",
    outcome: "success",
    result: { total: 1200 }
  }),
  ask,
  AssistantEvent.TurnCompleted.make({ throughSeq: 1 }),
  pick
]

describe("ChatView.fromEntries", () => {
  it("has the messages and their blocks, with the user's answer, and nothing internal", () => {
    const shown = view(quoting)

    expect(shown.messages).toEqual([
      ChatView.UserMessage.make({ id: hi.id, text: "Order 300 totes", at: 1000 }),
      ChatView.AssistantMessage.make({
        id: "m1",
        text: "That's $1,200. Which color?",
        at: 6000,
        block: {
          kind: "choose_one",
          props: { options: ["red", "blue"] },
          status: "answered",
          answer: { choice: "blue" }
        }
      })
    ])

    const json = JSON.stringify(Schema.encodeSync(ChatView.View)(shown))

    for (const internal of ["toolu_quote", "ModelOutput", "TurnStarted"]) {
      expect(json).not.toContain(internal)
    }
  })

  it("says a block is open until it's answered, and closed when it closes without an answer", () => {
    const choose = AssistantEvent.AssistantMessage.make({
      id: "m2",
      text: "Red or blue?",
      block: AssistantEvent.MessageBlock.make({
        kind: "choose_one",
        props: { options: ["red", "blue"] }
      })
    })

    const status = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
      view(events).messages.flatMap((message) =>
        Predicate.isTagged(message, "AssistantMessage") ? [message.block?.status] : []
      )

    expect(status([choose])).toEqual(["open"])
    expect(status([choose, AssistantEvent.BlocksClosed.make({ messageIds: ["m2"] })])).toEqual(["closed"])
  })

  it("says what works: a turn, one about to start, and specialists; and whether the last turn failed", () => {
    const runId = RunId.fromKey("view-test")

    const working = view([
      hi,
      AssistantEvent.TurnStarted.make({ assistant: "test" }),
      AssistantEvent.SpecialistStarted.make({
        runId,
        specialist: "research",
        goal: "internal brief"
      })
    ])

    expect(working.activity).toEqual({
      working: true,
      specialists: [{ specialist: "research", since: 3000 }]
    })
    expect(JSON.stringify(working)).not.toContain("internal brief")

    const failed = view([
      hi,
      AssistantEvent.TurnStarted.make({ assistant: "test" }),
      AssistantEvent.TurnFailed.make({ throughSeq: 2, message: "AnthropicError: overloaded" })
    ])

    expect(failed.activity).toEqual({ working: false, specialists: [] })
    expect(failed.failed).toBe(true)
    expect(JSON.stringify(failed)).not.toContain("overloaded")
    expect(ChatView.isIdle(failed)).toBe(true)

    // A workflow's update, submitted, wakes a turn: working until a turn reads it.
    const woken = view([submittedUpdate("workflow:Order", { status: "shipped" })])

    expect(woken.activity.working).toBe(true)

    // One a turn appended wakes nothing.
    expect(view([storedUpdate("workflow:Order", { status: "shipped" })]).activity.working).toBe(false)
  })

  it("shows every app event it gets as a row between the messages, in the log's order", () => {
    const shipped = Update.make({
      id: InputId.fromKey("shipped"),
      source: "workflow:Order",
      payload: { status: "shipped" }
    })

    const json = Schema.encodeSync(Schema.toCodecJson(Update))(shipped)

    expect(JSON.stringify(json)).toBe(
      '{"_tag":"Update","id":"shipped","source":"workflow:Order","payload":{"status":"shipped"}}'
    )

    // As `subscribe` streams it: decoded.
    const shown = ChatView.fromEntries(
      [
        { chatId, seq: 1, at: 1000, event: hi },
        { chatId, seq: 2, at: 2000, event: shipped },
        { chatId, seq: 3, at: 3000, event: ask }
      ],
      Updating
    )

    expect(shown.messages.map((message) => message._tag)).toEqual(["UserMessage", "AppEvent", "AssistantMessage"])
    expect(shown.messages[1]).toEqual(
      ChatView.AppEvent.make({ id: "app-event:2", tag: "Update", data: json, at: 2000 })
    )

    const rows = shown.messages.flatMap((message) => (Predicate.isTagged(message, "AppEvent") ? [message] : []))

    // A row reads back as its event with the event's schema; another schema reads nothing.
    expect(rows.map(ChatView.decodeEvent(Update))).toEqual([Option.some(shipped)])
    expect(rows.map(ChatView.decodeEvent(Schema.TaggedStruct("Other", { n: Schema.Int })))).toEqual([Option.none()])

    // As the log stores it, without a definition: the stored JSON, without the input mark.
    const stored = Schema.decodeUnknownSync(AssistantEvent.StoredAppEvent)(json)
    const fromLog = view([hi, AppEvents.markInput(stored), ask])

    expect(fromLog.messages[1]).toEqual(
      ChatView.AppEvent.make({ id: "app-event:2", tag: "Update", data: json, at: 2000 })
    )
  })

  it("says when the chat was deleted, and that nothing works in it any more, even mid-turn", () => {
    const shown = view([
      hi,
      AssistantEvent.TurnStarted.make({ assistant: "test" }),
      AssistantEvent.ChatDeleted.make({})
    ])

    expect(shown.deleted).toBe(true)
    expect(ChatView.isIdle(shown)).toBe(true)
    expect(shown.messages.map((message) => message.id)).toEqual([hi.id])
  })
})

describe("ChatView.apply", () => {
  it("replaces changed messages in place, adds new ones after, and changes nothing applied twice", () => {
    const first: ChatView.Update = {
      seq: 2,
      messages: [
        ChatView.UserMessage.make({ id: hi.id, text: "hi", at: 1 }),
        ChatView.AssistantMessage.make({ id: "m1", text: "Pick", at: 2 })
      ],
      activity: { working: true, specialists: [] },
      failed: false,
      deleted: false
    }

    const second: ChatView.Update = {
      seq: 5,
      messages: [
        ChatView.AssistantMessage.make({
          id: "m1",
          text: "Pick",
          at: 2,
          block: { kind: "k", props: null, status: "closed" }
        }),
        ChatView.AssistantMessage.make({ id: "m2", text: "Done", at: 5 })
      ],
      activity: { working: false, specialists: [] },
      failed: false,
      deleted: false
    }

    const once = [first, second].reduce(ChatView.apply, ChatView.empty)
    const twice = [first, second, first, second].reduce(ChatView.apply, ChatView.empty)

    expect(once.messages.map((message) => message.id)).toEqual([hi.id, "m1", "m2"])
    expect(once.seq).toBe(5)
    expect(twice).toEqual(once)
  })
})

describe("updates", () => {
  it.live("folds to the log's view, in JSON over the wire, and after a seq streams only what came since", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make((request) =>
        Scripted.lastInput(request).includes("shipped") ? Scripted.reply("It shipped.") : Scripted.reply("Hi!")
      )

      const { log, folded, since, filtered } = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Updating).submit(chat, say("hi"))
        const first = yield* collectUntil(Updating, chat, (es) => turnsDone(es) >= 1)
        yield* (yield* Updating).submit(chat, update("workflow:Order", { status: "shipped" }))
        const log = yield* collectUntil(Updating, chat, (es) => turnsDone(es) >= 2)

        const wire = Schema.toCodecJson(ChatView.Update)

        const folded = yield* (yield* Updating).subscribe(chat).pipe(
          ChatView.updates(Updating),
          Stream.map((update) =>
            Schema.decodeUnknownSync(wire)(JSON.parse(JSON.stringify(Schema.encodeSync(wire)(update))))
          ),
          Stream.scan(() => ChatView.empty, ChatView.apply),
          Stream.takeUntil((shown) => shown.seq >= log.at(-1)!.seq),
          Stream.runLast,
          Effect.map(Option.getOrThrow)
        )

        // Data-first, to cover both forms.
        const since = yield* ChatView.updates((yield* Updating).subscribe(chat), Updating, {
          after: first.at(-1)!.seq
        }).pipe(
          Stream.takeUntil((changes) => changes.seq >= log.at(-1)!.seq),
          Stream.runCollect
        )

        // What the app lets its user see: here, none of its events.
        const filtered = yield* (yield* Updating).subscribe(chat).pipe(
          Stream.filter(({ event }) => AssistantEvent.isLibraryEvent(event)),
          ChatView.updates(Updating),
          Stream.scan(() => ChatView.empty, ChatView.apply),
          Stream.takeUntil((shown) => shown.seq >= log.at(-1)!.seq),
          Stream.runLast,
          Effect.map(Option.getOrThrow)
        )

        return { log, folded, since, filtered }
      }).pipe(
        Effect.provide(
          updatingAssistant((turn) => turn.loop({ instructions: "Be brief.", history: readUpdates }), model.layer)
        )
      )

      const shown = (view: ReadonlyArray<ChatView.Message>) =>
        view.map((message) => (Predicate.isTagged(message, "AppEvent") ? message.tag : message.text))

      expect(folded).toEqual(ChatView.fromEntries(log, Updating))
      expect(shown(folded.messages)).toEqual(["hi", "Hi!", "Update", "It shipped."])
      expect(since.flatMap((changes) => shown(changes.messages))).toEqual(["Update", "It shipped."])
      expect(shown(filtered.messages)).toEqual(["hi", "Hi!", "It shipped."])
    })
  )
})

describe("AssistantEvent.UserMessage", () => {
  it("gets a new id when none is given, and keeps one that is", () => {
    const [a, b] = [AssistantEvent.UserMessage.make({ text: "a" }), AssistantEvent.UserMessage.make({ text: "b" })]
    const given = AssistantEvent.UserMessage.make({ id: InputId.fromKey("client:1"), text: "c" })

    expect(a.id).not.toEqual(b.id)
    expect(given.id).toBe(InputId.fromKey("client:1"))
  })
})
