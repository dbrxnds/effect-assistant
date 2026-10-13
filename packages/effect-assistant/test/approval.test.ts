/**
 * Tools with Effect's `needsApproval`: a turn's call waits for the user's
 * decision instead of running, the decision is an input, an approved call runs
 * then (also after a crash, with the same key), and a stale one expires.
 */
import { describe, expect, it } from "@effect/vitest"
import type * as LanguageModel from "effect/ai/LanguageModel"
import * as Response from "effect/ai/Response"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  Assistant,
  AssistantEngine,
  AssistantEvent,
  AssistantLoop,
  AssistantToolCall,
  ChatId,
  ChatLog,
  Specialist,
  Timeline,
  ToolApproval,
  ToolDiscovery
} from "../src/index.ts"
import { awaitingApprovalOutput } from "../src/internal/history.ts"
import {
  collectUntil,
  failures,
  finished,
  idle,
  newChat,
  notWorking,
  runMemory,
  say,
  simple,
  text,
  turnsDone
} from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const instructions = "You help a small team."

/** Shared with the client: place_order's parameters. */
const PlaceOrderParams = Schema.Struct({ sku: Schema.String, quantity: Schema.Int })

const PlaceOrder = Tool.make("place_order", {
  description: "Places an order. The user approves it first.",
  parameters: PlaceOrderParams,
  success: Schema.Struct({ reference: Schema.String }),
  needsApproval: true,
  dependencies: [AssistantToolCall.AssistantToolCall]
})

const OrderTools = Toolkit.make(PlaceOrder)

interface Ran {
  readonly sku: string
  readonly key: string
}

/** place_order's handlers, recording each run with its idempotency key. */
const orderTools = Effect.gen(function* () {
  const runs = yield* Ref.make<ReadonlyArray<Ran>>([])

  const layer = OrderTools.toLayer({
    place_order: ({ sku }) =>
      Effect.gen(function* () {
        const key = yield* AssistantToolCall.idempotencyKey

        yield* Ref.update(runs, (all) => [...all, { sku, key }])

        return { reference: "R-1" }
      })
  })

  return { runs: Ref.get(runs), layer }
})

const Ordering = Assistant.make("approval")

/** The model asks to place the order, with a message, and reads what came of it. */
const script: Scripted.Script = (request) => {
  const last = Scripted.lastInput(request)

  if (last.includes("approved your call")) return Scripted.reply("Placed: R-1.")

  if (last.includes("rejected your call")) return Scripted.reply(last.includes("too many") ? "Fewer, then." : "OK.")

  if (last.includes("moved on without approving")) return Scripted.reply("Dropped the order.")

  return [
    Scripted.call("place_order", { sku: "tote", quantity: 300 }),
    Scripted.call("send_user_message", { text: "Here's the order: approve it to place it.", wait: false })
  ]
}

const ordering = (
  handler: Assistant.Handler<
    Assistant.TurnServices | LanguageModel.LanguageModel | AssistantLoop.ToolkitServices<typeof OrderTools.tools>
  >
) =>
  Effect.map(orderTools, ({ runs, layer }) => ({
    runs,
    layer: runMemory(Ordering.toLayer(handler).pipe(Layer.provide(layer)), Scripted.layer(script))
  }))

const looping = (turn: Assistant.Turn) => turn.loop({ instructions, toolkit: OrderTools })

const requested = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.flatMap(({ event }) => (Predicate.isTagged(event, "ApprovalRequested") ? [event] : []))

const timelineOf = (entries: ReadonlyArray<AssistantEvent.Entry>) => Timeline.fromEntries(entries)

const approvalItems = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  timelineOf(entries).items.flatMap((item) => (Predicate.isTagged(item, "ToolApproval") ? [item] : []))

describe("a tool with needsApproval, in a turn", () => {
  it.live("waits for the user instead of running, the step's other calls run, and the turn ends", () =>
    Effect.gen(function* () {
      const { runs, layer } = yield* ordering(looping)

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Ordering).submit(chat, say("Order 300 totes."))

        return yield* collectUntil(Ordering, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(layer))

      const [request] = requested(entries)

      expect(request?.tool).toBe("place_order")
      expect(request?.params).toEqual({ sku: "tote", quantity: 300 })
      expect(yield* runs).toEqual([])
      // The step's message went out, and the turn completed: the call to approve answers the user.
      expect(text(entries)).toContain("approve it")
      expect(entries.at(-1)?.event._tag).toBe("TurnCompleted")
      expect(entries.filter(({ event }) => Predicate.isTagged(event, "ModelOutput"))).toHaveLength(1)
      expect(
        approvalItems(entries).map(({ id, tool, status, reason, outcome }) => ({
          id,
          tool,
          status,
          reason,
          outcome
        }))
      ).toEqual([
        {
          id: request!.callId,
          tool: "place_order",
          status: "pending",
          reason: undefined,
          outcome: undefined
        }
      ])
    })
  )

  it.live("runs an approved call once, with its params and key, and the model reads its result", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(script)
      const { runs, layer } = yield* orderTools

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Ordering).submit(chat, say("Order 300 totes."))
        const first = yield* collectUntil(Ordering, chat, (es) => turnsDone(es) >= 1)
        const callId = requested(first)[0]!.callId

        // A double click: the decision is stored once.
        yield* (yield* Ordering).submit(chat, ToolApproval.approve({ id: callId }))
        yield* (yield* Ordering).submit(chat, ToolApproval.approve({ id: callId }))

        return yield* collectUntil(Ordering, chat, (es) => text(es).includes("placed: r-1") && idle(es))
      }).pipe(Effect.provide(runMemory(Ordering.toLayer(looping).pipe(Layer.provide(layer)), model.layer)))

      const callId = requested(entries)[0]!.callId
      const last = (yield* model.requests).at(-1)

      expect(failures(entries)).toEqual([])
      expect(entries.filter(({ event }) => Predicate.isTagged(event, "ApprovalDecision"))).toHaveLength(1)
      expect(yield* runs).toEqual([{ sku: "tote", key: `tool-call:${callId}` }])
      expect(Scripted.lastInput(last!)).toContain("The user approved your call to place_order")
      expect(Scripted.lastInput(last!)).toContain('"reference":"R-1"')
      // The call's own result, for the provider, says it waits.
      expect(Scripted.toolResults(last!).map(Scripted.resultText)).toContain(awaitingApprovalOutput)
      expect(approvalItems(entries).map(({ status, outcome }) => [status, outcome])).toEqual([["approved", "success"]])
    })
  )

  it.live(
    "doesn't run a rejected call: the model reads the rejection and the reason, and a later decision is ignored",
    () =>
      Effect.gen(function* () {
        const { runs, layer } = yield* ordering(looping)

        const entries = yield* Effect.gen(function* () {
          const chat = yield* newChat
          yield* (yield* Ordering).submit(chat, say("Order 300 totes."))
          const first = yield* collectUntil(Ordering, chat, (es) => turnsDone(es) >= 1)
          const callId = requested(first)[0]!.callId

          yield* (yield* Ordering).submit(chat, ToolApproval.reject({ id: callId }, { reason: "too many" }))
          yield* collectUntil(Ordering, chat, (es) => text(es).includes("fewer, then") && idle(es))
          yield* (yield* Ordering).submit(chat, ToolApproval.approve({ id: callId }))

          return yield* ChatLog.ChatLog.use((log) => log.read(chat))
        }).pipe(Effect.provide(layer))

        expect(yield* runs).toEqual([])
        expect(entries.filter(({ event }) => Predicate.isTagged(event, "ApprovalDecision"))).toHaveLength(1)
        expect(approvalItems(entries).map(({ status, reason }) => [status, reason])).toEqual([["rejected", "too many"]])
      })
  )

  it.live("expires a call the user moved on from: the model reads it, and a later approval is ignored", () =>
    Effect.gen(function* () {
      const { runs, layer } = yield* ordering((turn) =>
        Stream.unwrap(ToolApproval.expireStale({ messages: 1 }).pipe(Effect.as(looping(turn))))
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Ordering).submit(chat, say("Order 300 totes."))
        const first = yield* collectUntil(Ordering, chat, (es) => turnsDone(es) >= 1)
        const callId = requested(first)[0]!.callId

        yield* (yield* Ordering).submit(chat, say("Never mind, what's the weather?"))
        yield* collectUntil(Ordering, chat, (es) => text(es).includes("dropped the order") && idle(es))
        yield* (yield* Ordering).submit(chat, ToolApproval.approve({ id: callId }))

        return yield* ChatLog.ChatLog.use((log) => log.read(chat))
      }).pipe(Effect.provide(layer))

      expect(yield* runs).toEqual([])
      expect(entries.filter(({ event }) => Predicate.isTagged(event, "ApprovalDecision"))).toHaveLength(0)
      expect(approvalItems(entries).map(({ status }) => status)).toEqual(["expired"])
    })
  )

  it.live("waits in a loop of your own too, since the turn runs it", () =>
    Effect.gen(function* () {
      const { runs, layer } = yield* ordering((turn) =>
        AssistantLoop.run({
          instructions: turn.instructions(instructions),
          toolkit: OrderTools,
          history: turn.history()
        })
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Ordering).submit(chat, say("Order 300 totes."))

        return yield* collectUntil(Ordering, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(layer))

      expect(requested(entries)).toHaveLength(1)
      expect(yield* runs).toEqual([])
    })
  )
})

describe("an approved call after a crash", () => {
  it.live("runs again, once, with the key it would have had", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* ChatId.make()
      const callId = "toolu_order_1"
      const { runs, layer } = yield* orderTools
      const done = yield* Deferred.make<void>()

      // The process died after the approved call started, before its result.
      yield* log.append(chat, [
        say("Order 300 totes."),
        AssistantEvent.TurnStarted.make({ assistant: "approval" }),
        AssistantEvent.ModelOutput.make({
          parts: [
            Response.makePart("tool-call", {
              id: callId,
              name: "place_order",
              params: { sku: "tote", quantity: 300 },
              providerExecuted: false
            })
          ],
          seenThroughSeq: 2
        }),
        AssistantEvent.ApprovalRequested.make({ callId, tool: "place_order", params: { sku: "tote", quantity: 300 } }),
        AssistantEvent.TurnCompleted.make({ throughSeq: 3 }),
        ToolApproval.approve({ id: callId }),
        AssistantEvent.TurnStarted.make({ assistant: "approval" }),
        AssistantEvent.ToolStarted.make({ callId, tool: "place_order" })
      ])

      const handlers = Ordering.toLayer((turn) =>
        looping(turn).pipe(Stream.ensuring(Deferred.succeed(done, undefined)))
      ).pipe(Layer.provide(layer))

      yield* Effect.scoped(
        Layer.build(
          handlers.pipe(Layer.provide(AssistantEngine.layerMemory), Layer.provide(Scripted.layer(script)))
        ).pipe(Effect.andThen(Deferred.await(done)), Effect.timeout("5 seconds"))
      )

      const entries = yield* log.read(chat)

      expect(yield* runs).toEqual([{ sku: "tote", key: `tool-call:${callId}` }])
      expect(text(entries)).toContain("placed: r-1")
    }).pipe(Effect.provide(ChatLog.layerMemory))
  )
})

describe("a tool with needsApproval, elsewhere", () => {
  it.live("fails a specialist's call, since a run can't ask the user, and the run reads why", () =>
    Effect.gen(function* () {
      const { runs, layer } = yield* orderTools
      const Buyer = Specialist.make("buyer", { description: "Buys things." })
      const WithBuyer = Assistant.make("approval-specialist", { specialists: [Buyer] })

      const handlers = WithBuyer.toLayer(simple({ instructions })).pipe(
        Layer.provide(
          Buyer.toLayer((run) => run.loop({ instructions: "Buy it.", toolkit: OrderTools })).pipe(Layer.provide(layer))
        )
      )

      const model = Scripted.layer((request) => {
        const last = Scripted.lastInput(request)

        // The buyer's run: it tries to order, then reports what it read.
        if (!request.tools.includes("spawn_specialist")) {
          return Scripted.hasCalled(request, "place_order")
            ? [Scripted.text("I couldn't: it needs approval.")]
            : [Scripted.call("place_order", { sku: "tote", quantity: 300 })]
        }

        if (last.includes("<specialist")) return Scripted.reply("The buyer couldn't order it.")

        return Scripted.hasCalled(request, "spawn_specialist")
          ? Scripted.wait()
          : [Scripted.call("spawn_specialist", { specialist: "buyer", goal: "Buy 300 totes." })]
      })

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* WithBuyer).submit(chat, say("Have the buyer order 300 totes."))

        return yield* collectUntil(WithBuyer, chat, (es) => text(es).includes("couldn't") && notWorking(es))
      }).pipe(Effect.provide(runMemory(handlers, model)))

      expect(finished(entries).map((run) => run.report)).toEqual(["I couldn't: it needs approval."])
      expect(yield* runs).toEqual([])
    })
  )

  it.effect("fails a ToolDiscovery layer over a catalog that has one", () =>
    Effect.gen(function* () {
      const { layer } = yield* orderTools

      const exit = yield* Layer.build(ToolDiscovery.layer(OrderTools).pipe(Layer.provide(layer))).pipe(
        Effect.scoped,
        Effect.exit
      )

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("place_order sets needsApproval")
    })
  )
})

describe("approvals on the timeline", () => {
  it.live("are an item for every call, only the yes or no, and the client builds the decision", () =>
    Effect.gen(function* () {
      const { layer } = yield* ordering(looping)
      const Wire = Timeline.Change()

      const timeline = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Ordering).submit(chat, say("Order 300 totes."))
        yield* collectUntil(Ordering, chat, (es) => turnsDone(es) >= 1)

        // As an RPC would: encoded with its schema, to JSON text and back.
        return yield* (yield* Ordering).subscribe(chat).pipe(
          Timeline.changes(Ordering),
          Stream.map((change) =>
            Schema.decodeUnknownSync(Wire)(JSON.parse(JSON.stringify(Schema.encodeSync(Wire)(change))))
          ),
          Timeline.fold,
          Stream.takeUntil((timeline) => Timeline.isIdle(timeline) && timeline.items.length > 2),
          Stream.runLast
        )
      }).pipe(Effect.provide(layer))

      const items = Option.match(timeline, { onNone: () => [], onSome: ({ items }) => items })

      const lines = items.map((item) =>
        Match.valueTags(item, {
          UserMessage: (sent) => `user: ${sent.text}`,
          AssistantMessage: (sent) => `assistant: ${sent.text}`,
          ToolApproval: (approval) => `${approval.status}: ${approval.tool}`
        })
      )

      // The assistant's message says what it asks; the item is the yes or no.
      expect(lines).toEqual([
        "user: Order 300 totes.",
        "assistant: Here's the order: approve it to place it.",
        "pending: place_order"
      ])

      const approval = items.flatMap((item) => (Predicate.isTagged(item, "ToolApproval") ? [item] : []))[0]!

      expect(Object.keys(approval).sort()).toEqual(["_tag", "at", "id", "outcome", "reason", "status", "tool"])
      expect(ToolApproval.approve(approval)).toEqual(
        AssistantEvent.ApprovalDecision.make({
          id: ToolApproval.decisionId(approval.id),
          callId: approval.id,
          decision: "approved"
        })
      )
    })
  )
})
