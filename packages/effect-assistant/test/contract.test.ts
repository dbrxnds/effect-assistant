/**
 * The library's contract with a real model (Haiku): what the library tells
 * the model (`Instructions.protocol`, its tools' descriptions, how the
 * history reads) is enough for it to reply, use a tool, hand work to a
 * specialist, fill in a block, go on when the user acted from a block, and
 * go on after a crash, and the provider accepts what the library sends. Needs
 * ANTHROPIC_API_KEY.
 *
 * Which tool an app's model should pick for a request is the app's to test,
 * with its own prompts and tools; the mechanics are tested on a scripted
 * model in the other files.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Prompt from "effect/ai/Prompt"
import * as Response from "effect/ai/Response"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import {
  Assistant,
  AssistantEngine,
  AssistantEvent,
  AssistantToolCall,
  Block,
  BlockKit,
  ChatId,
  ChatLog,
  InputId,
  Specialist
} from "../src/index.ts"
import {
  collectUntil,
  failures,
  finished,
  memoryAssistant,
  newChat,
  notWorking,
  runMemory,
  say,
  simple,
  TestAssistant,
  text,
  toolsRun,
  traceEntries,
  turnsDone,
  viewedMessages,
  withHandlers,
  withTools
} from "./utils/fixtures.ts"
import { realModel } from "./utils/realModel.ts"

const instructions = "You help a small team. Be brief."

const GetWeather = Tool.make("get_weather", {
  description: "Current weather for a city.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ city: Schema.String, weather: Schema.String })
})

const weather = withHandlers(Toolkit.make(GetWeather), {
  get_weather: ({ city }) => Effect.succeed({ city, weather: "hail, 3 degrees celsius" })
})

describe("with a real model", () => {
  it.live("replies through send_user_message, and ends the turn", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* TestAssistant).submit(chat, say("Say hi in one short message."))
      const entries = yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(AssistantEvent.assistantTexts(entries).length).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(memoryAssistant(simple({ instructions }), realModel)))
  )

  it.live("uses a tool, and tells the user what it found", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* TestAssistant).submit(chat, say("What's the weather in Oslo right now?"))
      const entries = yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(toolsRun(entries)).toContain("get_weather")
      expect(text(entries)).toContain("hail")
    }).pipe(Effect.provide(memoryAssistant(withTools({ instructions, toolkit: weather }), realModel)))
  )

  // The loop only waited; the reply pass runs the real model, with wait in its history.
  const waitedOnly = (turn: Assistant.Turn) =>
    Stream.make(
      AssistantEvent.ModelOutput.make({
        parts: [Response.makePart("tool-call", { id: "wait-1", name: "wait", params: {}, providerExecuted: false })]
      }),
      AssistantEvent.ToolResult.make({ callId: "wait-1", tool: "wait", outcome: "success", result: "waiting" })
    ).pipe(Stream.concat(turn.replyIfOwed({ instructions })))

  it.live("replies in the reply pass, which forces send_user_message", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* TestAssistant).submit(chat, say("Thanks, that's all I needed."))
      const entries = yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(AssistantEvent.assistantTexts(entries)).toHaveLength(1)
    }).pipe(Effect.provide(memoryAssistant(waitedOnly, realModel)))
  )

  it.live("hands a question to a specialist, and relays its report", () => {
    const Research = Specialist.make("research", { description: "Answers factual questions." })

    const ResearchAssistant = Assistant.make("contract-research", { specialists: [Research] })

    const layer = runMemory(
      ResearchAssistant.toLayer(simple({ instructions })).pipe(
        Layer.provide(Research.toLayer((run) => run.loop({ instructions: "Answer in one sentence." })))
      ),
      realModel
    )

    return Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* ResearchAssistant).submit(chat, say("Ask the research specialist what the capital of Canada is."))

      const entries = yield* collectUntil(
        ResearchAssistant,
        chat,
        (es) => text(es).includes("ottawa") && notWorking(es)
      )

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(toolsRun(entries)).toContain("spawn_specialist")
      expect(finished(entries).map((run) => run.status)).toEqual(["answered"])
    }).pipe(Effect.provide(layer))
  })

  it.live("fills in a block that fits its props", () => {
    const ChooseOne = Block.make("choose_one", {
      description: "Let the user pick one of a few options with buttons.",
      props: Schema.Struct({ options: Schema.Array(Schema.String) }),
      answer: Schema.Struct({ choice: Schema.String })
    })

    const Blocks = Assistant.make("contract-blocks", { blocks: BlockKit.make([ChooseOne]) })

    return Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* Blocks).submit(chat, say("Should the banner be red or blue? Give me buttons to pick."))
      const entries = yield* collectUntil(Blocks, chat, (es) => turnsDone(es) >= 1)

      const block = entries.flatMap(({ event }) =>
        Predicate.isTagged(event, "AssistantMessage") && event.block !== undefined ? [event.block] : []
      )[0]

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(block?.kind).toBe("choose_one")
      expect(Schema.is(ChooseOne.props)(block?.props)).toBe(true)
    }).pipe(Effect.provide(runMemory(Blocks.toLayer(simple({ instructions })), realModel)))
  })

  it.live("shows the order for the user to place, and goes on once the app says they placed it", () => {
    const OrderDraft = Block.make("order_draft", {
      description:
        "An order ready to place, with a Place order button. The user places it with the button; you can't place orders yourself.",
      props: Schema.Struct({ product: Schema.String, quantity: Schema.Int })
    })

    class OrderPlaced extends Schema.TaggedClass<OrderPlaced>()("OrderPlaced", {
      id: InputId.InputId,
      product: Schema.String,
      quantity: Schema.Int,
      reference: Schema.String
    }) {}

    const Ordering = Assistant.make("contract-orders", {
      blocks: BlockKit.make([OrderDraft]),
      events: [OrderPlaced]
    })

    const placedOrders: Assistant.HistoryView<OrderPlaced> = (entries) =>
      entries.map((entry) =>
        entry.event instanceof OrderPlaced
          ? Prompt.userMessage({
              content: [
                Prompt.textPart({
                  text: `The user placed the order from your block: ${entry.event.quantity} ${entry.event.product}, reference ${entry.event.reference}.`
                })
              ]
            })
          : entry
      )

    return Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* Ordering).submit(chat, say("Order 300 tote bags."))
      const first = yield* collectUntil(Ordering, chat, (es) => turnsDone(es) >= 1)

      const message = viewedMessages(first).find((shown) => shown.block?.kind === "order_draft")

      expect(failures(first), traceEntries(first)).toEqual([])
      expect(message?.block?.props).toMatchObject({ quantity: 300 })

      // The button: the app's own API places the order with the props the user saw, and tells the chat.
      const draft = yield* Schema.decodeUnknownEffect(OrderDraft.props)(message?.block?.props)

      yield* (yield* Ordering).submit(
        chat,
        OrderPlaced.make({ id: InputId.fromKey(`${message!.id}:placed`), ...draft, reference: "ACM-7K2Q9X" })
      )

      const entries = yield* collectUntil(Ordering, chat, (es) => turnsDone(es) >= 2)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(text(entries)).toContain("acm-7k2q9x")
    }).pipe(
      Effect.provide(
        runMemory(
          Ordering.toLayer((turn) => turn.run({ instructions, history: placedOrders })),
          realModel
        )
      )
    )
  })

  it.live("runs a call a crash cut off again, then goes on", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* ChatId.make()
      const ran = yield* Deferred.make<string>()
      const Resumer = Assistant.make("contract-resumer")

      const SendReport = Tool.make("send_report", {
        description: "Sends the weekly report.",
        success: Schema.String,
        dependencies: [AssistantToolCall.AssistantToolCall]
      })

      const sendReport = withHandlers(Toolkit.make(SendReport), {
        send_report: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(ran, (yield* AssistantToolCall.AssistantToolCall).callId)

            return "sent"
          })
      })

      // What the log holds after a restart: the call started, and the process died before its result.
      yield* log.append(chat, [
        say("Send the weekly report."),
        AssistantEvent.TurnStarted.make({ assistant: "contract-resumer" }),
        AssistantEvent.ModelOutput.make({
          parts: [
            Response.makePart("tool-call", {
              id: "toolu_report_1",
              name: "send_report",
              params: {},
              providerExecuted: false
            })
          ],
          seenThroughSequence: 2
        }),
        AssistantEvent.ToolStarted.make({ callId: "toolu_report_1", tool: "send_report" })
      ])

      const layer = Resumer.toLayer(withTools({ instructions, toolkit: sendReport })).pipe(
        Layer.provideMerge(AssistantEngine.layerMemory),
        Layer.provide(realModel)
      )

      const entries = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)

          expect(yield* Deferred.await(ran)).toBe("toolu_report_1")

          return yield* collectUntil(Resumer, chat, (es) => turnsDone(es) >= 1).pipe(Effect.provide(context))
        })
      )

      // The provider took the replayed call's history, and the model went on to tell the user.
      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(AssistantEvent.assistantTexts(entries).length).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(ChatLog.layerMemory))
  )
})
