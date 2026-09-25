/**
 * The library's contract with a real model (Haiku): what the library tells
 * the model (`Instructions.protocol`, its tools' descriptions, how the
 * history reads) is enough for it to reply, use a tool, hand work to a
 * specialist, fill in a block, and go on after a crash, and the provider
 * accepts what the library sends. Needs ANTHROPIC_API_KEY.
 *
 * Which tool an app's model should pick for a request is the app's to test,
 * with its own prompts and tools; the mechanics are tested on a scripted
 * model in the other files.
 */
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  Assistant,
  AssistantEngine,
  AssistantEvent,
  AssistantToolCall,
  Block,
  BlockKit,
  ChatId,
  ChatLog,
  Specialist
} from "../src/index.ts"
import {
  collectUntil,
  failures,
  finished,
  memoryAssistant,
  newChat,
  notWorking,
  realModel,
  runMemory,
  say,
  simple,
  TestAssistant,
  testModel,
  text,
  toolsRun,
  traceEntries,
  turnsDone
} from "./fixtures.ts"

const instructions = "You help a small team. Be brief."

const weather = Tool.make({
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  run: ({ city }) => Effect.succeed({ city, weather: "hail, 3 degrees celsius" })
})

describe("with a real model", () => {
  it.live("replies through send_user_message, and ends the turn with wait", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* TestAssistant.submit(chat, say("Say hi in one short message."))
      const entries = yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(AssistantEvent.assistantTexts(entries).length).toBeGreaterThanOrEqual(1)
      expect(toolsRun(entries)).toContain("wait")
    }).pipe(Effect.provide(memoryAssistant(simple({ instructions }), realModel)))
  )

  it.live("uses a tool, and tells the user what it found", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* TestAssistant.submit(chat, say("What's the weather in Oslo right now?"))
      const entries = yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(toolsRun(entries)).toContain("get_weather")
      expect(text(entries)).toContain("hail")
    }).pipe(Effect.provide(memoryAssistant(simple({ instructions, toolkit: Toolkit.make(weather) }), realModel)))
  )

  // The loop only waited; the reply pass runs the real model, with wait in its history.
  const waitedOnly = (turn: Assistant.Turn) =>
    Stream.make(
      AssistantEvent.ModelOutput.make({
        items: [{ type: "function_call", call_id: "wait-1", name: "wait", arguments: "{}" }]
      }),
      AssistantEvent.ToolResult.make({ callId: "wait-1", tool: "wait", output: "waiting" })
    ).pipe(Stream.concat(turn.replyIfOwed({ model: testModel, instructions })))

  it.live("replies in the reply pass, which forces send_user_message", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* TestAssistant.submit(chat, say("Thanks, that's all I needed."))
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
        Layer.provide(
          Research.toLayer((run) => run.loop({ model: testModel, instructions: "Answer in one sentence." }))
        )
      ),
      realModel
    )

    return Effect.gen(function* () {
      const chat = yield* newChat
      yield* ResearchAssistant.submit(chat, say("Ask the research specialist what the capital of Canada is."))

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
      yield* Blocks.submit(chat, say("Should the banner be red or blue? Give me buttons to pick."))
      const entries = yield* collectUntil(Blocks, chat, (es) => turnsDone(es) >= 1)

      const block = entries.flatMap(({ event }) =>
        Predicate.isTagged(event, "AssistantMessage") && event.block !== undefined ? [event.block] : []
      )[0]

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(block?.kind).toBe("choose_one")
      expect(Schema.is(ChooseOne.props)(block?.props)).toBe(true)
    }).pipe(Effect.provide(runMemory(Blocks.toLayer(simple({ instructions })), realModel)))
  })

  it.live("runs a call a crash cut off again, then goes on", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* ChatId.make
      const ran = yield* Deferred.make<string>()
      const Resumer = Assistant.make("contract-resumer")

      const sendReport = Tool.make({
        name: "send_report",
        description: "Sends the weekly report.",
        inputSchema: Tool.noInput,
        run: () =>
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
          items: [{ type: "function_call", call_id: "toolu_report_1", name: "send_report", arguments: "{}" }],
          seenThroughSeq: 2
        }),
        AssistantEvent.ToolStarted.make({ callId: "toolu_report_1", tool: "send_report" })
      ])

      const layer = Resumer.toLayer(simple({ instructions, toolkit: Toolkit.make(sendReport) })).pipe(
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
