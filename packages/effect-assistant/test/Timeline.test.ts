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
import { Assistant, AssistantEvent, ChatId, Timeline, InputId, RunId } from "../src/index.ts"
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
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, sequence: i + 1, at: (i + 1) * 1000, event }))

const timeline = (events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>) =>
  Timeline.fromEntries(entries(events))

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
  AssistantEvent.ModelOutput.make({ parts: [call], seenThroughSequence: 2 }),
  AssistantEvent.ToolStarted.make({ callId: "toolu_quote", tool: "quote_order" }),
  AssistantEvent.ToolResult.make({
    callId: "toolu_quote",
    tool: "quote_order",
    outcome: "success",
    result: { total: 1200 }
  }),
  ask,
  AssistantEvent.TurnCompleted.make({ throughSequence: 1 }),
  pick
]

describe("Timeline.fromEntries", () => {
  it("has the messages and their blocks, with the user's answer, and nothing internal", () => {
    const shown = timeline(quoting)

    expect(shown.items).toEqual([
      Timeline.UserMessage.make({ id: hi.id, text: "Order 300 totes", at: 1000 }),
      Timeline.AssistantMessage.make({
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

    const json = JSON.stringify(Schema.encodeSync(Timeline.Change())(Timeline.snapshot(entries(quoting))))

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
      timeline(events).items.flatMap((item) =>
        Predicate.isTagged(item, "AssistantMessage") ? [item.block?.status] : []
      )

    expect(status([choose])).toEqual(["open"])
    expect(status([choose, AssistantEvent.BlocksClosed.make({ messageIds: ["m2"] })])).toEqual(["closed"])
  })

  it("says what works: a turn, one about to start, and specialists; and whether the last turn failed", () => {
    const runId = RunId.fromKey("timeline-test")

    const working = timeline([
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

    const failed = timeline([
      hi,
      AssistantEvent.TurnStarted.make({ assistant: "test" }),
      AssistantEvent.TurnFailed.make({ throughSequence: 2, message: "AnthropicError: overloaded" })
    ])

    expect(failed.activity).toEqual({ working: false, specialists: [] })
    expect(failed.failed).toBe(true)
    expect(JSON.stringify(failed)).not.toContain("overloaded")
    expect(Timeline.isIdle(failed)).toBe(true)

    // A workflow's update, submitted, wakes a turn: working until a turn reads it.
    const woken = timeline([submittedUpdate("workflow:Order", { status: "shipped" })])

    expect(woken.activity.working).toBe(true)

    // One a turn appended wakes nothing.
    expect(timeline([storedUpdate("workflow:Order", { status: "shipped" })]).activity.working).toBe(false)
  })

  it("shows the app events in `show` as items typed with their schemas, and leaves out the rest", () => {
    const shipped = Update.make({
      id: InputId.fromKey("shipped"),
      source: "workflow:Order",
      payload: { status: "shipped" }
    })

    const note = Note.make({ text: "for the model" })

    // As `subscribe` streams them: decoded.
    const decoded = [
      { chatId, sequence: 1, at: 1000, event: hi },
      { chatId, sequence: 2, at: 2000, event: shipped },
      { chatId, sequence: 3, at: 2500, event: note },
      { chatId, sequence: 4, at: 3000, event: ask }
    ]

    const shown: Timeline.Timeline<Update> = Timeline.fromEntries(decoded, Viewing, { show: [Update] })

    // Exhaustive over the events shown: the item's `_tag` is the event's, and the event is decoded.
    const lines = shown.items.map((item) =>
      Match.valueTags(item, {
        UserMessage: (sent) => `user: ${sent.text}`,
        AssistantMessage: (sent) => `assistant: ${sent.text}`,
        Update: (eventItem) =>
          `${eventItem.id} at ${eventItem.at}: ${eventItem.event.source} ${eventItem.event instanceof Update}`,
        ToolApproval: (approval) => `approve ${approval.tool}?`
      })
    )

    expect(lines).toEqual([
      "user: Order 300 totes",
      "app-event:2 at 2000: workflow:Order true",
      "assistant: That's $1,200. Which color?"
    ])

    // Without `show`, none of the app's events.
    expect(Timeline.fromEntries(decoded, Viewing).items.map((item) => item._tag)).toEqual([
      "UserMessage",
      "AssistantMessage"
    ])

    // On the wire, the event is in its JSON form, and the RPC's schema decodes it back.
    const Wire = Timeline.Change([Update])
    const json = Schema.encodeSync(Wire)(Timeline.snapshot(decoded, Viewing, { show: [Update] }))

    expect(JSON.stringify(json)).toContain(
      '{"_tag":"Update","id":"app-event:2","at":2000,"event":{"_tag":"Update","id":"shipped","source":"workflow:Order","payload":{"status":"shipped"}}}'
    )
    expect(Timeline.apply(Timeline.empty, Schema.decodeUnknownSync(Wire)(JSON.parse(JSON.stringify(json))))).toEqual(
      shown
    )

    // As the log stores it, marked as submitted: the same items.
    const stored = Schema.decodeUnknownSync(AssistantEvent.StoredAppEvent)(
      Schema.encodeSync(Schema.toCodecJson(Update))(shipped)
    )

    const log = entries([hi, AppEvents.markInput(stored), ask])

    expect(Timeline.fromEntries(log, Viewing, { show: [Update] }).items).toEqual(shown.items)
  })

  it("decodes a change without the items its schema doesn't name, or that don't decode", () => {
    const change = Schema.decodeUnknownSync(Timeline.Change([Update]))(
      JSON.parse(`{
        "sequence": 4,
        "items": [
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

    expect(change.items.map((item) => item.id)).toEqual([hi.id, "app-event:4"])
  })

  it("types a handler's updates with what it shows, so they must fit its RPC's schema", () => {
    const Rpcs = RpcGroup.make(Rpc.make("Subscribe", { success: Timeline.Change([Update]), stream: true }))

    const layers = [
      Rpcs.toLayer({ Subscribe: () => Stream.empty.pipe(Timeline.changes(Viewing, { show: [Update] })) }),
      // Showing fewer than the schema names is safe: the client never gets those items.
      Rpcs.toLayer({ Subscribe: () => Stream.empty.pipe(Timeline.changes(Viewing)) }),
      // @ts-expect-error an item the schema doesn't name couldn't be encoded, so this doesn't compile
      Rpcs.toLayer({ Subscribe: () => Stream.empty.pipe(Timeline.changes(Viewing, { show: [Update, Note] })) })
    ]

    expect(layers).toHaveLength(3)
  })

  it("says when the chat was deleted, and that nothing works in it any more, even mid-turn", () => {
    const shown = timeline([
      hi,
      AssistantEvent.TurnStarted.make({ assistant: "test" }),
      AssistantEvent.ChatDeleted.make({})
    ])

    expect(shown.deleted).toBe(true)
    expect(Timeline.isIdle(shown)).toBe(true)
    expect(shown.items.map((item) => item.id)).toEqual([hi.id])
  })
})

describe("Timeline.apply", () => {
  it("replaces changed messages in place, adds new ones after, and changes nothing applied twice", () => {
    const first: Timeline.Change = {
      sequence: 2,
      items: [
        Timeline.UserMessage.make({ id: hi.id, text: "hi", at: 1 }),
        Timeline.AssistantMessage.make({ id: "m1", text: "Pick", at: 2 })
      ],
      activity: { working: true, specialists: [] },
      failed: false,
      deleted: false
    }

    const second: Timeline.Change = {
      sequence: 5,
      items: [
        Timeline.AssistantMessage.make({
          id: "m1",
          text: "Pick",
          at: 2,
          block: { kind: "k", props: null, status: "closed" }
        }),
        Timeline.AssistantMessage.make({ id: "m2", text: "Done", at: 5 })
      ],
      activity: { working: false, specialists: [] },
      failed: false,
      deleted: false
    }

    const once = [first, second].reduce(Timeline.apply, Timeline.empty)
    const twice = [first, second, first, second].reduce(Timeline.apply, Timeline.empty)

    expect(once.items.map((item) => item.id)).toEqual([hi.id, "m1", "m2"])
    expect(once.sequence).toBe(5)
    expect(twice).toEqual(once)
  })
})

describe("Timeline.changes", () => {
  it.live("folds to the log's timeline, in JSON over the wire, and after a sequence streams only what came since", () =>
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
        const Wire = Timeline.Change([Update])

        const folded = yield* (yield* Updating).subscribe(chat).pipe(
          Timeline.changes(Updating, { show: [Update] }),
          Stream.map((change) =>
            Schema.decodeUnknownSync(Wire)(JSON.parse(JSON.stringify(Schema.encodeSync(Wire)(change))))
          ),
          Timeline.fold,
          Stream.takeUntil((shown) => shown.sequence >= log.at(-1)!.sequence),
          Stream.runLast,
          Effect.map(Option.getOrThrow)
        )

        // Data-first, to cover both forms.
        const since = yield* Timeline.changes((yield* Updating).subscribe(chat), Updating, {
          show: [Update],
          after: first.at(-1)!.sequence
        }).pipe(
          Stream.takeUntil((changes) => changes.sequence >= log.at(-1)!.sequence),
          Stream.runCollect
        )

        // Without `show`, none of the app's events reach the client.
        const hidden = yield* (yield* Updating).subscribe(chat).pipe(
          Timeline.changes(Updating),
          Timeline.fold,
          Stream.takeUntil((shown) => shown.sequence >= log.at(-1)!.sequence),
          Stream.runLast,
          Effect.map(Option.getOrThrow)
        )

        return { log, folded, since, hidden }
      }).pipe(
        Effect.provide(
          updatingAssistant((turn) => turn.run({ instructions: "Be brief.", history: readUpdates }), model.layer)
        )
      )

      const shown = (items: ReadonlyArray<Timeline.Item<Update>>) =>
        items.map((item) =>
          Match.valueTags(item, {
            UserMessage: (sent) => sent.text,
            AssistantMessage: (sent) => sent.text,
            Update: (eventItem) => `update: ${eventItem.event.payload["status"]}`,
            ToolApproval: (approval) => `approve ${approval.tool}?`
          })
        )

      expect(folded).toEqual(Timeline.fromEntries(log, Updating, { show: [Update] }))
      expect(shown(folded.items)).toEqual(["hi", "Hi!", "update: shipped", "It shipped."])
      expect(since.flatMap((change) => shown(change.items))).toEqual(["update: shipped", "It shipped."])
      expect(shown(hidden.items)).toEqual(["hi", "Hi!", "It shipped."])
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
