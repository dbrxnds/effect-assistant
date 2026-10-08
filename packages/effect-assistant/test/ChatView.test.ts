import { describe, expect, it } from "@effect/vitest"
import * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { AssistantEvent, ChatId, ChatView, Decision, DecisionId, InputId, RunId } from "../src/index.ts"
import {
  collectUntil,
  newChat,
  say,
  storedUpdate,
  turnsDone,
  update,
  Updating,
  updatingAssistant
} from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const chatId = Effect.runSync(ChatId.make)

const entries = (events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>) =>
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: (i + 1) * 1000, event }))

const view = (events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>) =>
  ChatView.fromEntries(entries(events), { wakes: new Set(["Update"]) })

const hi = AssistantEvent.UserMessage.make({ id: InputId.fromKey("hi"), text: "Order 300 totes" })

const call = Response.makePart("tool-call", {
  id: "toolu_quote",
  name: "quote_order",
  params: { sku: "tote", quantity: 300 },
  providerExecuted: false
})

const request = AssistantEvent.DecisionRequested.make({
  id: DecisionId.fromCallId("toolu_quote"),
  origin: AssistantEvent.CallOrigin.make({
    callId: "toolu_quote",
    tool: "quote_order",
    params: { secret: "internal" }
  }),
  preview: { total: 1200 }
})

const ask = AssistantEvent.AssistantMessage.make({
  id: "m1",
  text: "Place the order for $1,200?",
  block: AssistantEvent.MessageBlock.make({
    kind: Decision.kind,
    props: { decisionIds: [request.id] }
  })
})

const approve = AssistantEvent.BlockAnswer.make({
  id: InputId.fromKey("m1:answer"),
  messageId: "m1",
  kind: Decision.kind,
  value: Decision.answerAll({ decisionIds: [request.id] }, "approved")
})

/** A turn that parks a call, asks for the decision, and the user approves it. */
const deciding = [
  hi,
  AssistantEvent.TurnStarted.make({ assistant: "test" }),
  AssistantEvent.ModelOutput.make({ parts: [call], seenThroughSeq: 2 }),
  AssistantEvent.ToolStarted.make({ callId: "toolu_quote", tool: "quote_order" }),
  request,
  ask,
  AssistantEvent.TurnCompleted.make({ throughSeq: 1 }),
  approve,
  AssistantEvent.DecisionResolved.make({ id: request.id, outcome: "approved", answer: approve.id })
]

describe("ChatView.fromEntries", () => {
  it("has the messages and their blocks, with a decision's preview and outcome, and nothing internal", () => {
    const shown = view(deciding)

    expect(shown.messages).toEqual([
      ChatView.UserMessage.make({ id: hi.id, text: "Order 300 totes", at: 1000 }),
      ChatView.AssistantMessage.make({
        id: "m1",
        text: "Place the order for $1,200?",
        at: 6000,
        block: {
          kind: Decision.kind,
          props: { decisionIds: [request.id] },
          status: "answered",
          answer: { decisions: { [request.id]: "approved" } },
          decisions: [{ id: request.id, preview: { total: 1200 }, outcome: "approved" }]
        }
      })
    ])

    const json = JSON.stringify(Schema.encodeSync(ChatView.View)(shown))

    for (const internal of ["toolu_quote", "quote_order", "secret", "ModelOutput", "TurnStarted"]) {
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

    // A workflow's update wakes a turn: working until a turn reads it. The update itself isn't shown.
    const woken = view([storedUpdate("workflow:Order", { status: "shipped" })])

    expect(woken.activity.working).toBe(true)
    expect(woken.messages).toEqual([])
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
      failed: false
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
      failed: false
    }

    const once = [first, second].reduce(ChatView.apply, ChatView.empty)
    const twice = [first, second, first, second].reduce(ChatView.apply, ChatView.empty)

    expect(once.messages.map((message) => message.id)).toEqual([hi.id, "m1", "m2"])
    expect(once.seq).toBe(5)
    expect(twice).toEqual(once)
  })
})

describe("subscribeView", () => {
  it.live("folds to the log's view, in JSON over the wire, and after a seq streams only what came since", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make((request) =>
        Scripted.lastInput(request).includes("shipped") ? Scripted.reply("It shipped.") : Scripted.reply("Hi!")
      )

      const { log, folded, since } = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* Updating.submit(chat, say("hi"))
        const first = yield* collectUntil(Updating, chat, (es) => turnsDone(es) >= 1)
        yield* Updating.submit(chat, update("workflow:Order", { status: "shipped" }))
        const log = yield* collectUntil(Updating, chat, (es) => turnsDone(es) >= 2)

        const wire = Schema.toCodecJson(ChatView.Update)

        const folded = yield* Updating.subscribeView(chat).pipe(
          Stream.map((update) =>
            Schema.decodeUnknownSync(wire)(JSON.parse(JSON.stringify(Schema.encodeSync(wire)(update))))
          ),
          Stream.scan(() => ChatView.empty, ChatView.apply),
          Stream.takeUntil((shown) => shown.seq >= log.at(-1)!.seq),
          Stream.runLast,
          Effect.map(Option.getOrThrow)
        )

        const since = yield* Updating.subscribeView(chat, { after: first.at(-1)!.seq }).pipe(
          Stream.takeUntil((changes) => changes.seq >= log.at(-1)!.seq),
          Stream.runCollect
        )

        return { log, folded, since }
      }).pipe(Effect.provide(updatingAssistant((turn) => turn.loop({ instructions: "Be brief." }), model.layer)))

      expect(folded).toEqual(ChatView.fromEntries(log, { wakes: new Set(["Update"]) }))
      expect(folded.messages.map((message) => message.text)).toEqual(["hi", "Hi!", "It shipped."])
      expect(since.flatMap((changes) => changes.messages.map((message) => message.text))).toEqual(["It shipped."])
    })
  )
})
