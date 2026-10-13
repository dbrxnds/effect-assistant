import { describe, expect, it } from "@effect/vitest"
import * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import { Assistant, AssistantEvent, ChatId, ChatView, InputId, RunId } from "../src/index.ts"
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

/** Something for the model only, which no chat client should see. */
class Note extends Schema.TaggedClass<Note>()("Note", { text: Schema.String }) {}

const Viewing = Assistant.make("viewing", { events: [Update, Note] })

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

    const json = JSON.stringify(Schema.encodeSync(ChatView.Update())(ChatView.snapshot(entries(quoting))))

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

  it("shows the app events in `show` as rows typed with their schemas, and leaves out the rest", () => {
    const shipped = Update.make({
      id: InputId.fromKey("shipped"),
      source: "workflow:Order",
      payload: { status: "shipped" }
    })

    const note = Note.make({ text: "for the model" })

    // As `subscribe` streams them: decoded.
    const decoded = [
      { chatId, seq: 1, at: 1000, event: hi },
      { chatId, seq: 2, at: 2000, event: shipped },
      { chatId, seq: 3, at: 2500, event: note },
      { chatId, seq: 4, at: 3000, event: ask }
    ]

    const shown: ChatView.View<Update> = ChatView.fromEntries(decoded, Viewing, { show: [Update] })

    // Exhaustive over the events shown: the row's `_tag` is the event's, and the event is decoded.
    const lines = shown.messages.map((message) =>
      Match.valueTags(message, {
        UserMessage: (sent) => `user: ${sent.text}`,
        AssistantMessage: (sent) => `assistant: ${sent.text}`,
        Update: (row) => `${row.id} at ${row.at}: ${row.event.source} ${row.event instanceof Update}`
      })
    )

    expect(lines).toEqual([
      "user: Order 300 totes",
      "app-event:2 at 2000: workflow:Order true",
      "assistant: That's $1,200. Which color?"
    ])

    // Without `show`, none of the app's events.
    expect(ChatView.fromEntries(decoded, Viewing).messages.map((message) => message._tag)).toEqual([
      "UserMessage",
      "AssistantMessage"
    ])

    // On the wire, the event is in its JSON form, and the RPC's schema decodes it back.
    const Wire = ChatView.Update([Update])
    const json = Schema.encodeSync(Wire)(ChatView.snapshot(decoded, Viewing, { show: [Update] }))

    expect(JSON.stringify(json)).toContain(
      '{"_tag":"Update","id":"app-event:2","at":2000,"event":{"_tag":"Update","id":"shipped","source":"workflow:Order","payload":{"status":"shipped"}}}'
    )
    expect(ChatView.apply(ChatView.empty, Schema.decodeUnknownSync(Wire)(JSON.parse(JSON.stringify(json))))).toEqual(
      shown
    )

    // As the log stores it, marked as submitted: the same rows.
    const stored = Schema.decodeUnknownSync(AssistantEvent.StoredAppEvent)(
      Schema.encodeSync(Schema.toCodecJson(Update))(shipped)
    )

    const log = entries([hi, AppEvents.markInput(stored), ask])

    expect(ChatView.fromEntries(log, Viewing, { show: [Update] }).messages).toEqual(shown.messages)
  })

  it("decodes an update without the rows its schema doesn't name, or that don't decode", () => {
    const update = Schema.decodeUnknownSync(ChatView.Update([Update]))(
      JSON.parse(`{
        "seq": 4,
        "messages": [
          { "_tag": "UserMessage", "id": "${hi.id}", "text": "hi", "at": 1 },
          { "_tag": "Note", "id": "app-event:2", "at": 2, "event": { "_tag": "Note", "text": "hidden" } },
          { "_tag": "Update", "id": "app-event:3", "at": 3, "event": { "_tag": "Update", "source": 7 } },
          { "_tag": "Update", "id": "app-event:4", "at": 4, "event": { "_tag": "Update", "id": "u", "source": "s", "payload": {} } }
        ],
        "activity": { "working": false, "specialists": [] },
        "failed": false,
        "deleted": false
      }`)
    )

    expect(update.messages.map((message) => message.id)).toEqual([hi.id, "app-event:4"])
  })

  it("types a handler's updates with what it shows, so they must fit its RPC's schema", () => {
    const Rpcs = RpcGroup.make(Rpc.make("Subscribe", { success: ChatView.Update([Update]), stream: true }))

    const layers = [
      Rpcs.toLayer({ Subscribe: () => Stream.empty.pipe(ChatView.updates(Viewing, { show: [Update] })) }),
      // Showing fewer than the schema names is safe: the client never gets those rows.
      Rpcs.toLayer({ Subscribe: () => Stream.empty.pipe(ChatView.updates(Viewing)) }),
      // @ts-expect-error a row the schema doesn't name couldn't be encoded, so this doesn't compile
      Rpcs.toLayer({ Subscribe: () => Stream.empty.pipe(ChatView.updates(Viewing, { show: [Update, Note] })) })
    ]

    expect(layers).toHaveLength(3)
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

      const { log, folded, since, hidden } = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Updating).submit(chat, say("hi"))
        const first = yield* collectUntil(Updating, chat, (es) => turnsDone(es) >= 1)
        yield* (yield* Updating).submit(chat, update("workflow:Order", { status: "shipped" }))
        const log = yield* collectUntil(Updating, chat, (es) => turnsDone(es) >= 2)

        // As an RPC would: encoded with its schema, to JSON text and back.
        const Wire = ChatView.Update([Update])

        const folded = yield* (yield* Updating).subscribe(chat).pipe(
          ChatView.updates(Updating, { show: [Update] }),
          Stream.map((update) =>
            Schema.decodeUnknownSync(Wire)(JSON.parse(JSON.stringify(Schema.encodeSync(Wire)(update))))
          ),
          ChatView.views,
          Stream.takeUntil((shown) => shown.seq >= log.at(-1)!.seq),
          Stream.runLast,
          Effect.map(Option.getOrThrow)
        )

        // Data-first, to cover both forms.
        const since = yield* ChatView.updates((yield* Updating).subscribe(chat), Updating, {
          show: [Update],
          after: first.at(-1)!.seq
        }).pipe(
          Stream.takeUntil((changes) => changes.seq >= log.at(-1)!.seq),
          Stream.runCollect
        )

        // Without `show`, none of the app's events reach the client.
        const hidden = yield* (yield* Updating).subscribe(chat).pipe(
          ChatView.updates(Updating),
          ChatView.views,
          Stream.takeUntil((shown) => shown.seq >= log.at(-1)!.seq),
          Stream.runLast,
          Effect.map(Option.getOrThrow)
        )

        return { log, folded, since, hidden }
      }).pipe(
        Effect.provide(
          updatingAssistant((turn) => turn.loop({ instructions: "Be brief.", history: readUpdates }), model.layer)
        )
      )

      const shown = (messages: ReadonlyArray<ChatView.Message<Update>>) =>
        messages.map((message) =>
          Match.valueTags(message, {
            UserMessage: (sent) => sent.text,
            AssistantMessage: (sent) => sent.text,
            Update: (row) => `update: ${row.event.payload["status"]}`
          })
        )

      expect(folded).toEqual(ChatView.fromEntries(log, Updating, { show: [Update] }))
      expect(shown(folded.messages)).toEqual(["hi", "Hi!", "update: shipped", "It shipped."])
      expect(since.flatMap((changes) => shown(changes.messages))).toEqual(["update: shipped", "It shipped."])
      expect(shown(hidden.messages)).toEqual(["hi", "Hi!", "It shipped."])
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
