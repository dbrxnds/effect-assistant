/**
 * Decisions, on a scripted model: a call that waits for the user's decision,
 * the answer that runs or declines it, answers the chat refuses, and
 * restarts in between.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Response from "effect/ai/Response"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import {
  Assistant,
  AssistantEngine,
  AssistantEvent,
  AssistantToolCall,
  BlockKit,
  ChatId,
  ChatLog,
  type ChatView,
  Decision,
  DecisionId,
  InputId,
  Specialist,
  ToolFailure
} from "../src/index.ts"
import {
  collectUntil,
  failures,
  finished,
  idle,
  layerStorage,
  newChat,
  notWorking,
  runEntity,
  runMemory,
  say,
  simple,
  text,
  toolsRun,
  traceEntries,
  viewedMessages,
  withHandlers,
  withTools
} from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const instructions = "You help a small team."

const Blocks = BlockKit.make([Decision.block])

const Deciding = Assistant.make("decisions-test", { blocks: Blocks })

const Order = Schema.Struct({ sku: Schema.String, quantity: Schema.Int })

const PlaceOrder = Tool.make("place_order", {
  description: "Places an order.",
  parameters: Order,
  success: Schema.Struct({ reference: Schema.String }),
  failure: ToolFailure.ToolFailure,
  dependencies: [AssistantToolCall.AssistantToolCall],
  needsApproval: true
})

interface Ran {
  readonly callId: string
  readonly key: string
  readonly params: typeof Order.Type
}

/** `place_order`, recording every run. */
const orderTools = Effect.gen(function* () {
  const ran = yield* Ref.make<ReadonlyArray<Ran>>([])

  const toolkit = withHandlers(Toolkit.make(PlaceOrder), {
    place_order: (params) =>
      Effect.gen(function* () {
        const call = yield* AssistantToolCall.AssistantToolCall
        const key = yield* AssistantToolCall.idempotencyKey
        yield* Ref.update(ran, (all) => [...all, { callId: call.callId, key, params }])

        return { reference: "R-1" }
      })
  })

  return { ran: Ref.get(ran), toolkit }
})

const Parked = Schema.Struct({
  status: Schema.Literal("waiting_for_decision"),
  decisionId: Schema.String
})

/** The decision id of the last parked call in the history. */
const parkedId = (request: Scripted.Request) =>
  Option.fromNullishOr(
    Scripted.toolResults(request)
      .flatMap((part) => Option.toArray(Schema.decodeUnknownOption(Parked)(part.result)))
      .at(-1)?.decisionId
  )

const askFor = (ids: ReadonlyArray<string>, text = "Place it?") =>
  Scripted.call("send_user_message", {
    text,
    wait: true,
    block: { kind: Decision.kind, props: { decisionIds: [...ids], approveLabel: "Place order" } }
  })

/**
 * Orders 300 totes, asks for the decision the call waits for, and replies to
 * the outcome.
 */
const orderScript =
  (quantity = 300): Scripted.Script =>
  (request) => {
    const last = Scripted.lastInput(request)

    if (last.includes('outcome="approved"')) return Scripted.reply(last.includes("R-1") ? "Placed: R-1." : "Hm.")

    if (last.includes('kind="decision"')) return Scripted.reply(last.includes("declined") ? "Cancelled." : "Hm.")

    const parked = parkedId(request)

    if (Option.isSome(Scripted.lastResult(request, "place_order"))) {
      return Option.isSome(parked) ? [askFor([parked.value])] : Scripted.reply("That didn't work.")
    }

    if (Option.isSome(Scripted.lastResult(request, "send_user_message"))) return Scripted.wait()

    return [Scripted.call("place_order", { sku: "tote", quantity })]
  }

/** The chat's events of one kind, by tag. */
const events = {
  ModelOutput: (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) => (Predicate.isTagged(event, "ModelOutput") ? [event] : [])),
  ToolResult: (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) => (Predicate.isTagged(event, "ToolResult") ? [event] : [])),
  AssistantMessage: (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) => (Predicate.isTagged(event, "AssistantMessage") ? [event] : [])),
  BlockAnswer: (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) => (Predicate.isTagged(event, "BlockAnswer") ? [event] : [])),
  DecisionRequested: (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) => (Predicate.isTagged(event, "DecisionRequested") ? [event] : [])),
  DecisionResolved: (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) => (Predicate.isTagged(event, "DecisionResolved") ? [event] : []))
}

/** The message with the decision block. */
const asked = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  viewedMessages(entries).find((message) => message.block?.kind === Decision.kind)

/** The answer a client sends for the message's decision block: through `BlockKit.toClient`, like the UI. */
const answerWith = (message: ChatView.AssistantMessage, outcome: AssistantEvent.DecisionOutcome) => {
  const answers: Array<AssistantEvent.BlockAnswer> = []

  const render = BlockKit.toClient(Blocks, {
    decision: ({ props, respond }) => respond(Decision.answerAll(props, outcome))
  })

  render(message, { respond: (answer) => answers.push(answer) })

  return answers[0]!
}

/** A second answer to the same block, as a client that didn't know it was answered would send. */
const anotherAnswer = (message: ChatView.AssistantMessage, decisions: Record<string, AssistantEvent.DecisionOutcome>) =>
  AssistantEvent.BlockAnswer.make({
    id: InputId.fromKey(`${message.id}:${Object.values(decisions).join(",")}:again`),
    messageId: message.id,
    kind: Decision.kind,
    value: { decisions }
  })

const waitingFor = (entries: ReadonlyArray<AssistantEvent.Entry>) => asked(entries) !== undefined && idle(entries)

describe("closing a block", () => {
  /** The order script, until the user asks something else; then a message that tries to close the decision block. */
  const closingScript: Scripted.Script = (request) => {
    if (!Scripted.lastInput(request).includes("What's new?")) return orderScript()(request)

    const refused = Scripted.lastResult(request, "send_user_message")

    if (Option.isSome(refused) && refused.value.includes("only their answer"))
      return Scripted.reply("Still waiting on your decision for the order.")

    const blockMessage = Scripted.toolResults(request)
      .flatMap((part) => /sent as message ([0-9a-f-]{36})/.exec(Scripted.resultText(part))?.[1] ?? [])
      .at(-1)

    return [
      Scripted.call("send_user_message", {
        text: "Nothing new.",
        wait: true,
        closes: blockMessage === undefined ? [] : [blockMessage]
      })
    ]
  }

  it.live("can't close a decision block that still waits for the user", () =>
    Effect.gen(function* () {
      const { ran, toolkit } = yield* orderTools
      const model = yield* Scripted.make(closingScript)

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Deciding).submit(chat, say("Order 300 totes."))
        const first = yield* collectUntil(Deciding, chat, waitingFor, "10 seconds")

        yield* (yield* Deciding).submit(chat, say("What's new?"))
        yield* collectUntil(Deciding, chat, (es) => text(es).includes("still waiting") && idle(es), "10 seconds")

        // The block still takes the user's answer, and it places the order.
        yield* (yield* Deciding).submit(chat, answerWith(asked(first)!, "approved"))

        return yield* collectUntil(Deciding, chat, (es) => text(es).includes("placed") && idle(es), "10 seconds")
      }).pipe(Effect.provide(runMemory(Deciding.toLayer(withTools({ instructions, toolkit })), model.layer)))

      const refusals = events
        .ToolResult(entries)
        .filter((result) => result.outcome === "failure" && result.tool === "send_user_message")

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(refusals.map((result) => result.kind)).toEqual(["decision_waiting"])
      expect(events.BlockAnswer(entries)).toHaveLength(1)
      expect(events.DecisionResolved(entries).map((resolved) => resolved.outcome)).toEqual(["approved"])
      expect(yield* ran).toHaveLength(1)
    })
  )
})

describe("a call that needs the user's decision", () => {
  it.live("is parked, and the user's yes runs exactly that call", () =>
    Effect.gen(function* () {
      const { ran, toolkit } = yield* orderTools
      const model = yield* Scripted.make(orderScript())

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Deciding).submit(chat, say("Order 300 totes."))
        const first = yield* collectUntil(Deciding, chat, waitingFor, "10 seconds")

        // Nothing ran yet: the call waits.
        expect(yield* ran).toEqual([])
        yield* (yield* Deciding).submit(chat, answerWith(asked(first)!, "approved"))

        return yield* collectUntil(Deciding, chat, (es) => text(es).includes("placed") && idle(es), "10 seconds")
      }).pipe(Effect.provide(runMemory(Deciding.toLayer(withTools({ instructions, toolkit })), model.layer)))

      const [call] = events
        .ModelOutput(entries)
        .flatMap((output) =>
          output.parts.flatMap((part) => (part.type === "tool-call" && part.name === "place_order" ? [part] : []))
        )

      const [request] = events.DecisionRequested(entries)
      const [resolved] = events.DecisionResolved(entries)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(request?.id).toBe(DecisionId.fromCallId(call!.id))
      expect(request?.origin).toEqual(
        AssistantEvent.CallOrigin.make({
          callId: call!.id,
          tool: "place_order",
          params: call!.params
        })
      )
      expect(resolved?.outcome).toBe("approved")
      // The same call, run once, with its id and key: a crash after this runs it again, and the key finds it.
      expect(yield* ran).toEqual([
        { callId: call!.id, key: `tool-call:${call!.id}`, params: { sku: "tote", quantity: 300 } }
      ])

      // It started only once the user approved it.
      const startedAt = entries.find(
        ({ event }) => Predicate.isTagged(event, "ToolStarted") && event.callId === call!.id
      )

      const resolvedAt = entries.find(({ event }) => Predicate.isTagged(event, "DecisionResolved"))

      expect(startedAt!.seq).toBeGreaterThan(resolvedAt!.seq)

      const requests = yield* model.requests
      // Parking didn't end the first turn: the model read the parked result and asked.
      expect(Option.getOrUndefined(Scripted.lastResult(requests[1]!, "place_order"))).toContain("waiting_for_decision")
      // After the answer, the model read what was decided, then the call's result.
      const after = Scripted.inputs(requests.at(-1)!)
      expect(after.at(-2)).toContain(`${request!.id}: approved: place_order runs now`)
      expect(after.at(-1)).toContain('outcome="approved"')
      expect(after.at(-1)).toContain('"reference":"R-1"')
    })
  )

  it.live("doesn't run when the user declines, and the model is told", () =>
    Effect.gen(function* () {
      const { ran, toolkit } = yield* orderTools

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Deciding).submit(chat, say("Order 300 totes."))
        const first = yield* collectUntil(Deciding, chat, waitingFor, "10 seconds")
        yield* (yield* Deciding).submit(chat, answerWith(asked(first)!, "declined"))

        return yield* collectUntil(Deciding, chat, (es) => text(es).includes("cancelled") && idle(es), "10 seconds")
      }).pipe(
        Effect.provide(runMemory(Deciding.toLayer(withTools({ instructions, toolkit })), Scripted.layer(orderScript())))
      )

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(yield* ran).toEqual([])
      expect(events.DecisionResolved(entries).map((resolved) => resolved.outcome)).toEqual(["declined"])
      expect(toolsRun(entries)).not.toContain("place_order")
    })
  )

  it.live("is decided once: a second answer, or one for other decisions, is refused", () =>
    Effect.gen(function* () {
      const { ran, toolkit } = yield* orderTools
      const log = yield* ChatLog.ChatLog

      yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Deciding).submit(chat, say("Order 300 totes."))
        const message = asked(yield* collectUntil(Deciding, chat, waitingFor, "10 seconds"))!
        const [id] = events.DecisionRequested(yield* log.read(chat)).map((request) => request.id)
        const other = DecisionId.fromKey("another decision")

        // Decisions the block didn't ask about, one too many, and a message with no decision block: none is stored.
        yield* (yield* Deciding).submit(chat, anotherAnswer(message, { [other]: "approved" }))
        yield* (yield* Deciding).submit(chat, anotherAnswer(message, { [id!]: "approved", [other]: "approved" }))
        yield* (yield* Deciding).submit(
          chat,
          AssistantEvent.BlockAnswer.make({
            id: InputId.fromKey("no block"),
            messageId: "not-a-message",
            kind: Decision.kind,
            value: { decisions: { [id!]: "approved" } }
          })
        )
        expect(events.BlockAnswer(yield* log.read(chat))).toEqual([])

        const approve = answerWith(message, "approved")
        yield* (yield* Deciding).submit(chat, approve)
        // The same answer again (a double click) is the same input, stored once; a different one is refused.
        yield* (yield* Deciding).submit(chat, approve)
        yield* (yield* Deciding).submit(chat, anotherAnswer(message, { [id!]: "declined" }))
        yield* collectUntil(Deciding, chat, (es) => text(es).includes("placed") && idle(es), "10 seconds")

        const entries = yield* log.read(chat)

        expect(events.BlockAnswer(entries).map((answer) => answer.id)).toEqual([approve.id])
        expect(events.DecisionResolved(entries).map((resolved) => [resolved.outcome, resolved.answer])).toEqual([
          ["approved", approve.id]
        ])
        expect(yield* ran).toHaveLength(1)
      }).pipe(
        Effect.provide(
          Deciding.toLayer(withTools({ instructions, toolkit })).pipe(
            Layer.provideMerge(AssistantEngine.layerMemory),
            Layer.provide(Scripted.layer(orderScript()))
          )
        )
      )
    }).pipe(Effect.provide(layerStorage))
  )

  it.live("is decided once when two answers arrive at once, and runs at most once", () =>
    Effect.gen(function* () {
      const { ran, toolkit } = yield* orderTools
      const log = yield* ChatLog.ChatLog

      yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Deciding).submit(chat, say("Order 300 totes."))
        const message = asked(yield* collectUntil(Deciding, chat, waitingFor, "10 seconds"))!
        const [id] = events.DecisionRequested(yield* log.read(chat)).map((request) => request.id)

        const deciding = yield* Deciding

        yield* Effect.all(
          [
            deciding.submit(chat, anotherAnswer(message, { [id!]: "approved" })),
            deciding.submit(chat, anotherAnswer(message, { [id!]: "declined" }))
          ],
          { concurrency: "unbounded" }
        )

        const entries = yield* collectUntil(
          Deciding,
          chat,
          (es) => events.DecisionResolved(es).length > 0 && notWorking(es) && idle(es),
          "10 seconds"
        )

        const resolved = events.DecisionResolved(entries)

        expect(events.BlockAnswer(entries), traceEntries(entries)).toHaveLength(1)
        expect(resolved).toHaveLength(1)
        expect(yield* ran).toHaveLength(resolved[0]?.outcome === "approved" ? 1 : 0)
      }).pipe(
        Effect.provide(
          Deciding.toLayer(withTools({ instructions, toolkit })).pipe(
            Layer.provideMerge(AssistantEngine.layerMemory),
            Layer.provide(Scripted.layer(orderScript()))
          )
        )
      )
    }).pipe(Effect.provide(layerStorage))
  )

  it.live("waits only when its needsApproval says so, for these params", () =>
    Effect.gen(function* () {
      const Refund = Tool.make("refund", {
        description: "Refunds an amount.",
        parameters: Schema.Struct({ amount: Schema.Int }),
        success: Schema.String,
        needsApproval: ({ amount }) => amount > 100
      })

      const toolkit = withHandlers(Toolkit.make(Refund), {
        refund: ({ amount }) => Effect.succeed(`refunded ${amount}`)
      })

      const script: Scripted.Script = (request) => {
        if (Scripted.hasCalled(request, "refund")) return Scripted.reply("One refunded, one waits for you.")

        return [Scripted.call("refund", { amount: 20 }), Scripted.call("refund", { amount: 500 })]
      }

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Deciding).submit(chat, say("Refund both."))

        return yield* collectUntil(Deciding, chat, idle, "10 seconds")
      }).pipe(Effect.provide(runMemory(Deciding.toLayer(withTools({ instructions, toolkit })), Scripted.layer(script))))

      expect(events.ToolResult(entries).map((result) => result.result)).toContain("refunded 20")
      expect(
        events
          .DecisionRequested(entries)
          .flatMap(({ origin }) => (Predicate.isTagged(origin, "Call") ? [[origin.tool, origin.params]] : []))
      ).toEqual([["refund", { amount: 500 }]])
    })
  )

  it.live("can't be asked for with ids that don't wait for a decision", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make((request) =>
        Option.isSome(Scripted.lastResult(request, "send_user_message"))
          ? Scripted.reply("Sorry.")
          : [askFor([DecisionId.fromKey("made up")])]
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Deciding).submit(chat, say("Approve something."))

        return yield* collectUntil(Deciding, chat, idle, "10 seconds")
      }).pipe(Effect.provide(runMemory(Deciding.toLayer(simple({ instructions })), model.layer)))

      const [result] = events.ToolResult(entries)

      expect([result?.outcome, result?.kind]).toEqual(["failure", "not_waiting_for_decision"])
      expect(asked(entries)).toBeUndefined()
    })
  )

  it.live("needs the decision block in the assistant's blocks", () =>
    Effect.gen(function* () {
      const { toolkit } = yield* orderTools
      const NoBlocks = Assistant.make("no-decision-block")

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* NoBlocks).submit(chat, say("Order 300 totes."))

        return yield* collectUntil(NoBlocks, chat, (es) => failures(es).length > 0, "10 seconds")
      }).pipe(Effect.provide(runMemory(NoBlocks.toLayer(withTools({ instructions, toolkit })), Scripted.unused)))

      expect(failures(entries)[0]).toContain("add Decision.block")
    })
  )

  it.live("runs approved on the cluster engine too", () =>
    Effect.gen(function* () {
      const { ran, toolkit } = yield* orderTools

      yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Deciding).submit(chat, say("Order 300 totes."))
        const first = yield* collectUntil(Deciding, chat, waitingFor, "10 seconds")
        yield* (yield* Deciding).submit(chat, answerWith(asked(first)!, "approved"))
        yield* collectUntil(Deciding, chat, (es) => text(es).includes("placed") && idle(es), "10 seconds")
      }).pipe(
        Effect.provide(runEntity(Deciding.toLayer(withTools({ instructions, toolkit })), Scripted.layer(orderScript())))
      )

      expect(yield* ran).toHaveLength(1)
    })
  )
})

describe("a specialist's call that needs a decision", () => {
  it.live("fails: only the assistant can ask the user, and the run reports back", () =>
    Effect.gen(function* () {
      const { ran, toolkit } = yield* orderTools
      const Buyer = Specialist.make("buyer", { description: "Buys things." })
      const WithBuyer = Assistant.make("buyer-test", { blocks: Blocks, specialists: [Buyer] })

      const handlers = WithBuyer.toLayer(simple({ instructions })).pipe(
        Layer.provide(
          Buyer.toLayer((run) => run.loop({ instructions: "Buy it.", toolkit: toolkit.toolkit })).pipe(
            Layer.provide(toolkit.toolkit.toLayer(toolkit.handlers))
          )
        )
      )

      const script: Scripted.Script = (request) => {
        if (!request.tools.includes("send_user_message")) {
          const result = Scripted.lastResult(request, "place_order")

          return Option.isSome(result)
            ? [Scripted.text(result.value.includes("needs_decision") ? "It needs the user's approval." : "Bought.")]
            : [Scripted.call("place_order", { sku: "tote", quantity: 300 })]
        }

        const last = Scripted.lastInput(request)

        if (last.includes("<specialist"))
          return Scripted.reply(last.includes("approval") ? "Needs your approval." : "Done.")

        return Option.isSome(Scripted.lastResult(request, "spawn_specialist"))
          ? Scripted.wait()
          : [Scripted.call("spawn_specialist", { kind: "buyer", goal: "Buy 300 totes." })]
      }

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* WithBuyer).submit(chat, say("Have the buyer order 300 totes."))

        return yield* collectUntil(
          WithBuyer,
          chat,
          (es) => text(es).includes("approval") && notWorking(es),
          "10 seconds"
        )
      }).pipe(Effect.provide(runMemory(handlers, Scripted.layer(script))))

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(events.DecisionRequested(entries)).toEqual([])
      expect(finished(entries).map((run) => run.report)).toEqual(["It needs the user's approval."])
      expect(yield* ran).toEqual([])
    })
  )
})

describe("decisions across a restart", () => {
  const callId = "toolu_parked_1"
  const decisionId = DecisionId.fromCallId(callId)
  const params = { sku: "tote", quantity: 300 }

  /** What the log holds once a turn parked the call and asked for its decision. */
  const parkedLog = [
    say("Order 300 totes."),
    AssistantEvent.TurnStarted.make({ assistant: Deciding.name }),
    AssistantEvent.ModelOutput.make({
      parts: [
        Response.makePart("tool-call", {
          id: callId,
          name: "place_order",
          params,
          providerExecuted: false
        })
      ],
      seenThroughSeq: 2
    }),
    AssistantEvent.DecisionRequested.make({
      id: decisionId,
      origin: AssistantEvent.CallOrigin.make({ callId, tool: "place_order", params })
    }),
    AssistantEvent.ModelOutput.make({
      parts: [
        Response.makePart("tool-call", {
          id: "toolu_ask_1",
          name: "send_user_message",
          params: { text: "Place it?", wait: true },
          providerExecuted: false
        })
      ],
      seenThroughSeq: 4
    }),
    AssistantEvent.ToolStarted.make({ callId: "toolu_ask_1", tool: "send_user_message" }),
    AssistantEvent.AssistantMessage.make({
      id: "message-1",
      text: "Place it?",
      block: AssistantEvent.MessageBlock.make({
        kind: Decision.kind,
        props: { decisionIds: [decisionId] }
      })
    }),
    AssistantEvent.ToolResult.make({
      callId: "toolu_ask_1",
      tool: "send_user_message",
      outcome: "success",
      result: "sent as message message-1"
    }),
    AssistantEvent.TurnCompleted.make({ throughSeq: 8 })
  ]

  const approve = AssistantEvent.BlockAnswer.make({
    id: InputId.fromKey("message-1:answer"),
    messageId: "message-1",
    kind: Decision.kind,
    value: { decisions: { [decisionId]: "approved" } }
  })

  /** Starts the engine on the log as it is, runs `effect`, and waits until the approved call ran. */
  const restart = <A, E, R>(ran: Deferred.Deferred<Ran>, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const RecordingTools = Toolkit.make(PlaceOrder)

      const toolkit = withHandlers(RecordingTools, {
        place_order: (order) =>
          Effect.gen(function* () {
            const call = yield* AssistantToolCall.AssistantToolCall
            yield* Deferred.succeed(ran, {
              callId: call.callId,
              key: yield* AssistantToolCall.idempotencyKey,
              params: order
            })

            return { reference: "R-1" }
          })
      })

      const handlers = Deciding.toLayer(withTools({ instructions, toolkit })).pipe(
        Layer.provideMerge(AssistantEngine.layerMemory),
        Layer.provide(Scripted.layer(orderScript()))
      )

      return yield* Effect.scoped(
        Layer.build(handlers).pipe(
          Effect.flatMap((context) => Effect.provideContext(effect, context)),
          Effect.andThen(Deferred.await(ran)),
          Effect.timeout("10 seconds")
        )
      )
    })

  it.live("runs a call parked before the restart once the user approves it, with its id and params", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* ChatId.make
      const ran = yield* Deferred.make<Ran>()

      yield* log.append(chat, parkedLog)

      const run = yield* restart(
        ran,
        Deciding.use((deciding) => deciding.submit(chat, approve))
      )

      expect(run).toEqual({ callId, key: `tool-call:${callId}`, params })
    }).pipe(Effect.provide(layerStorage))
  )

  it.live("resolves an answer the restart cut off before it was resolved, then runs the call", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* ChatId.make
      const ran = yield* Deferred.make<Ran>()

      // The answer was stored, and the process stopped before its decision was resolved.
      yield* log.append(chat, [...parkedLog, approve])

      const run = yield* restart(ran, Effect.void)
      const resolved = events.DecisionResolved(yield* log.read(chat))

      expect(run.callId).toBe(callId)
      expect(resolved.map((event) => [event.id, event.outcome, event.answer])).toEqual([
        [decisionId, "approved", approve.id]
      ])
    }).pipe(Effect.provide(layerStorage))
  )

  it.live("runs an approved call a restart cut off while it ran again, with the same key", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* ChatId.make
      const ran = yield* Deferred.make<Ran>()

      yield* log.append(chat, [
        ...parkedLog,
        approve,
        AssistantEvent.DecisionResolved.make({
          id: decisionId,
          outcome: "approved",
          answer: approve.id
        }),
        AssistantEvent.TurnStarted.make({ assistant: Deciding.name }),
        AssistantEvent.ToolStarted.make({ callId, tool: "place_order" })
      ])

      const run = yield* restart(ran, Effect.void)

      expect(run).toEqual({ callId, key: `tool-call:${callId}`, params })
    }).pipe(Effect.provide(layerStorage))
  )
})
