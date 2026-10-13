/**
 * What the library does with what the model answers, on a scripted model:
 * messages mid-turn, specialist runs, blocks, discovery, skills, and both
 * engines. How a real model uses it is in `contract.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  Assistant,
  AssistantActivity,
  AssistantEngine,
  AssistantEvent,
  Block,
  BlockKit,
  ChatLog,
  Instructions,
  Specialist,
  ToolDiscovery,
  ToolFailure
} from "../src/index.ts"
import { toJsonText } from "../src/internal/schema.ts"
import {
  collectUntil,
  failures,
  finished,
  idle,
  layerStorage,
  memoryAssistant,
  newChat,
  notWorking,
  runEntity,
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
import * as Scripted from "./utils/scripted.ts"

const instructions = "You help a small team."

/** Whether a request is the assistant's (it can message the user), not a specialist's. */
const isAssistant = (request: Scripted.Request) => request.tools.includes("send_user_message")

const { hasCalled } = Scripted

describe("a turn", () => {
  it.live("puts the protocol before the instructions", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(() => Scripted.reply("Hi."))

      yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("hi"))
        yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(memoryAssistant(simple({ instructions }), model.layer)))

      const [request] = yield* model.requests

      expect(request?.system).toBe(`${Instructions.protocol}\n\n${instructions}`)
      expect(request?.toolChoice).toBe("auto")
      expect(request?.tools).toEqual(["send_user_message", "wait"])
    })
  )

  it.live("stores each model step's parts, model, response id, usage, and duration", () =>
    Effect.gen(function* () {
      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("hi"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(
        Effect.provide(
          memoryAssistant(
            simple({ instructions }),
            Scripted.layer(() => Scripted.reply("Hi."))
          )
        )
      )

      const [step] = entries.flatMap(({ event }) => (Predicate.isTagged(event, "ModelOutput") ? [event] : []))

      expect(step?.parts.map((part) => part.type)).toEqual(["tool-call"])
      expect(step?.model).toBe(Scripted.model)
      expect(step?.responseId).toBe("response_1")
      expect(step?.usage?.inputTokens).toEqual({
        total: 120,
        uncached: 20,
        cacheRead: 100,
        cacheWrite: 0
      })
      expect(step?.usage?.outputTokens.total).toBe(8)
      expect(step?.durationMillis).toBeGreaterThanOrEqual(0)
    })
  )

  it.live("picks up a message sent while a tool runs, at its next step", () =>
    Effect.gen(function* () {
      const LookupOrder = Tool.make("lookup_order", {
        description: "Look up an order.",
        parameters: Schema.Struct({ orderId: Schema.String }),
        success: Schema.Struct({ orderId: Schema.String, status: Schema.String })
      })

      const lookup = withHandlers(Toolkit.make(LookupOrder), {
        lookup_order: ({ orderId }) => Effect.sleep("1 second").pipe(Effect.as({ orderId, status: "shipped" }))
      })

      const script: Scripted.Script = (request) => {
        const all = Scripted.inputs(request).join("\n")

        // The second message is held until the lookup's result is in; then the model reads both.
        if (Option.isSome(Scripted.result(request, "lookup_order"))) {
          return Scripted.reply(all.includes("12 times 12") ? "Shipped. And 144." : "Shipped.")
        }

        return hasCalled(request, "lookup_order")
          ? Scripted.wait()
          : [Scripted.call("lookup_order", { orderId: "A-17" })]
      }

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("Check order A-17."))
        yield* collectUntil(TestAssistant, chat, (es) =>
          es.some(({ event }) => Predicate.isTagged(event, "ToolStarted"))
        )
        yield* (yield* TestAssistant).submit(chat, say("Also, what's 12 times 12?"))

        return yield* collectUntil(TestAssistant, chat, (es) => text(es).includes("144") && idle(es))
      }).pipe(Effect.provide(memoryAssistant(withTools({ instructions, toolkit: lookup }), Scripted.layer(script))))

      expect(failures(entries), traceEntries(entries)).toEqual([])
      // One turn read both messages.
      expect(turnsDone(entries)).toBe(1)
    })
  )
})

const Research = Specialist.make("research", { description: "Answers research questions." })

const ResearchLive = Research.toLayer((run) => run.loop({ instructions: "Answer in one line." }))

const ResearchAssistant = Assistant.make("research-test", { specialists: [Research] })

const researchHandlers = ResearchAssistant.toLayer(simple({ instructions })).pipe(Layer.provide(ResearchLive))

/** Spawns research for the first message, follows up for the second, and relays each report. */
const researchScript: Scripted.Script = (request) => {
  if (!isAssistant(request)) {
    return [Scripted.text(Scripted.lastInput(request).includes("province") ? "Ontario." : "Ottawa.")]
  }

  const last = Scripted.lastInput(request)

  if (last.includes("<specialist"))
    return Scripted.reply(last.includes("Ontario") ? "It's in Ontario." : "It's Ottawa.")

  if (Option.isSome(Scripted.lastResult(request, "spawn_specialist"))) return Scripted.reply("Asking research.")

  if (Option.isSome(Scripted.lastResult(request, "message_specialist"))) return Scripted.reply("Asking again.")

  const runId = Scripted.spawnedRunId(request)

  return Option.isSome(runId)
    ? [
        Scripted.call("message_specialist", {
          runId: runId.value,
          message: "Which province is it in?"
        })
      ]
    : [
        Scripted.call("spawn_specialist", {
          specialist: "research",
          goal: "What's the capital of Canada?"
        })
      ]
}

describe("specialist runs", () => {
  it.live("reports back as an input, and a turn relays it", () =>
    Effect.gen(function* () {
      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* ResearchAssistant).submit(chat, say("What's the capital of Canada?"))

        return yield* collectUntil(ResearchAssistant, chat, (es) => text(es).includes("ottawa") && notWorking(es))
      }).pipe(Effect.provide(runMemory(researchHandlers, Scripted.layer(researchScript))))

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(finished(entries).map((run) => [run.specialist, run.status, run.report])).toEqual([
        ["research", "answered", "Ottawa."]
      ])
      expect(entries.filter(({ event }) => Predicate.isTagged(event, "SpecialistStarted"))).toHaveLength(1)
    })
  )

  it.live("continues a finished run with a follow-up, as its next brief", () =>
    Effect.gen(function* () {
      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* ResearchAssistant).submit(chat, say("What's the capital of Canada?"))
        yield* collectUntil(ResearchAssistant, chat, (es) => text(es).includes("ottawa") && notWorking(es))
        yield* (yield* ResearchAssistant).submit(chat, say("Which province is it in?"))

        return yield* collectUntil(ResearchAssistant, chat, (es) => text(es).includes("ontario") && notWorking(es))
      }).pipe(Effect.provide(runMemory(researchHandlers, Scripted.layer(researchScript))))

      const [first, second] = finished(entries)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(second?.runId).toBe(first?.runId)
      expect([first?.brief, second?.brief]).toEqual([1, 2])
      expect(toolsRun(entries)).toContain("message_specialist")
    })
  )

  // A slow search keeps the specialist busy long enough to steer or stop it.
  const SearchArchive = Tool.make("search_archive", {
    description: "Search the archive.",
    parameters: Schema.Struct({ query: Schema.String }),
    success: Schema.Struct({ query: Schema.String, results: Schema.Array(Schema.String) })
  })

  const archive = withHandlers(Toolkit.make(SearchArchive), {
    search_archive: ({ query }) =>
      Effect.sleep("1 second").pipe(Effect.as({ query, results: ["2024: Lisbon", "2025: Porto"] }))
  })

  const Archivist = Specialist.make("archivist", { description: "Looks things up in the archive." })

  const ArchivistLive = Archivist.toLayer((run) =>
    run.loop({ instructions: "Search, then answer.", toolkit: archive.toolkit })
  ).pipe(Layer.provide(archive.toolkit.toLayer(archive.handlers)))

  const ArchiveAssistant = Assistant.make("archive-test", { specialists: [Archivist] })

  const archiveHandlers = ArchiveAssistant.toLayer(simple({ instructions })).pipe(Layer.provide(ArchivistLive))

  /** Spawns the archivist; a second message steers or stops it, as `then` says. */
  const archiveScript =
    (then: "message_specialist" | "stop_specialist"): Scripted.Script =>
    (request) => {
      if (!isAssistant(request)) {
        if (!hasCalled(request, "search_archive")) return [Scripted.call("search_archive", { query: "offsites" })]

        return [Scripted.text(Scripted.inputs(request).join(" ").includes("2025") ? "Lisbon, then Porto." : "Lisbon.")]
      }

      const last = Scripted.lastInput(request)
      const runId = Option.getOrElse(Scripted.spawnedRunId(request), () => "")

      if (last.includes("<specialist")) return Scripted.reply(last.includes("Porto") ? "Lisbon and Porto." : "Lisbon.")

      if (Scripted.inputs(request).length === 1) {
        return hasCalled(request, "spawn_specialist")
          ? Scripted.reply("On it.")
          : [
              Scripted.call("spawn_specialist", {
                specialist: "archivist",
                goal: "Where was the 2024 offsite?"
              })
            ]
      }

      return hasCalled(request, then)
        ? Scripted.reply("Done.")
        : [
            then === "message_specialist"
              ? Scripted.call(then, { runId, message: "Also find the 2025 one." })
              : Scripted.call(then, { runId })
          ]
    }

  const Status = Schema.Struct({ status: Schema.String })

  const statuses = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) =>
      Predicate.isTagged(event, "ToolResult") && event.tool.endsWith("_specialist")
        ? Option.toArray(Option.map(Schema.decodeUnknownOption(Status)(event.result), (output) => output.status))
        : []
    )

  it.live("steers a running run: it reads the message at its next step", () =>
    Effect.gen(function* () {
      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* ArchiveAssistant).submit(chat, say("Where was the 2024 offsite?"))
        yield* collectUntil(ArchiveAssistant, chat, (es) => statuses(es).includes("started"))
        yield* (yield* ArchiveAssistant).submit(chat, say("And the 2025 one?"))

        return yield* collectUntil(ArchiveAssistant, chat, (es) => text(es).includes("porto") && notWorking(es))
      }).pipe(Effect.provide(runMemory(archiveHandlers, Scripted.layer(archiveScript("message_specialist")))))

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(statuses(entries)).toContain("steered")
      // Steered, not continued: one report, for the second brief.
      expect(finished(entries).map((run) => [run.status, run.brief])).toEqual([["answered", 2]])
    })
  )

  it.live("stops a running run: it reports that it stopped, and no turn starts for it", () =>
    Effect.gen(function* () {
      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* ArchiveAssistant).submit(chat, say("Where was the 2024 offsite?"))
        yield* collectUntil(ArchiveAssistant, chat, (es) => statuses(es).includes("started"))
        yield* (yield* ArchiveAssistant).submit(chat, say("Never mind, stop it."))

        return yield* collectUntil(ArchiveAssistant, chat, (es) => finished(es).length > 0 && notWorking(es))
      }).pipe(Effect.provide(runMemory(archiveHandlers, Scripted.layer(archiveScript("stop_specialist")))))

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(finished(entries).map((run) => run.status)).toEqual(["stopped"])
      // The turn that stopped it is the last one: a stopped run wakes nothing.
      const stoppedAt = entries.find(({ event }) => Predicate.isTagged(event, "SpecialistFinished"))?.seq ?? 0
      expect(entries.some(({ event, seq }) => seq > stoppedAt && Predicate.isTagged(event, "TurnStarted"))).toBe(false)
    })
  )

  it.live("continues a finished run once when two messages arrive together", () =>
    Effect.gen(function* () {
      const script: Scripted.Script = (request) => {
        if (!isAssistant(request)) {
          return [Scripted.text(Scripted.inputs(request).join(" ").includes("province") ? "Ontario." : "Ottawa.")]
        }

        const last = Scripted.lastInput(request)
        const runId = Option.getOrElse(Scripted.spawnedRunId(request), () => "")

        if (last.includes("Ontario")) return Scripted.reply("It's in Ontario.")

        if (last.includes("Ottawa")) {
          return [
            Scripted.call("message_specialist", { runId, message: "Which province is it in?" }),
            Scripted.call("message_specialist", { runId, message: "Just the province." })
          ]
        }

        if (Option.isSome(Scripted.lastResult(request, "message_specialist"))) return Scripted.wait()

        return hasCalled(request, "spawn_specialist")
          ? Scripted.reply("Asking research.")
          : [
              Scripted.call("spawn_specialist", {
                specialist: "research",
                goal: "What's the capital of Canada?"
              })
            ]
      }

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* ResearchAssistant).submit(chat, say("What's the capital of Canada?"))

        return yield* collectUntil(ResearchAssistant, chat, (es) => text(es).includes("ontario") && notWorking(es))
      }).pipe(Effect.provide(runMemory(researchHandlers, Scripted.layer(script))))

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(statuses(entries).toSorted()).toEqual(["continued", "started", "steered"])
      expect(finished(entries).map((run) => [run.status, run.brief])).toEqual([
        ["answered", 1],
        ["answered", 3]
      ])
    })
  )

  it.live("reports a run whose handler died as failed, and a turn relays it", () =>
    Effect.gen(function* () {
      const Crasher = Specialist.make("crasher", { description: "Crashes." })
      const CrasherAssistant = Assistant.make("crasher-test", { specialists: [Crasher] })

      const handlers = CrasherAssistant.toLayer(simple({ instructions })).pipe(
        Layer.provide(Crasher.toLayer(() => Stream.die(new Error("boom"))))
      )

      const script: Scripted.Script = (request) => {
        const last = Scripted.lastInput(request)

        if (last.includes("<specialist")) return Scripted.reply(last.includes("boom") ? "It broke." : "Hm.")

        return hasCalled(request, "spawn_specialist")
          ? Scripted.reply("On it.")
          : [Scripted.call("spawn_specialist", { specialist: "crasher", goal: "Crash." })]
      }

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* CrasherAssistant).submit(chat, say("Go."))

        return yield* collectUntil(CrasherAssistant, chat, (es) => text(es).includes("broke") && notWorking(es))
      }).pipe(Effect.provide(runMemory(handlers, Scripted.layer(script))))

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(finished(entries).map((run) => run.status)).toEqual(["failed"])
    })
  )

  it.live("reports a run a shutdown cut off, and lets the chat go", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* newChat

      // The engine and the assistant live in this scope; closing it is the shutdown. The storage stays.
      const layer = archiveHandlers.pipe(
        Layer.provideMerge(AssistantEngine.layerMemory),
        Layer.provide(Scripted.layer(archiveScript("stop_specialist")))
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)

          yield* Effect.gen(function* () {
            yield* (yield* ArchiveAssistant).submit(chat, say("Where was the 2024 offsite?"))
            yield* collectUntil(ArchiveAssistant, chat, (es) => statuses(es).includes("started"))
          }).pipe(Effect.provide(context))
        })
      )

      const entries = yield* log.read(chat)

      expect(finished(entries).map((run) => run.status)).toEqual(["cut_off"])
      expect(AssistantActivity.fromEntries(entries).specialists.size).toBe(0)
    }).pipe(Effect.provide(layerStorage))
  )
})

describe("UI blocks", () => {
  const ChooseOne = Block.make("choose_one", {
    description: "Pick one of a few options.",
    props: Schema.Struct({ options: Schema.Array(Schema.String) }),
    answer: Schema.Struct({ choice: Schema.String })
  })

  const BlockAssistant = Assistant.make("blocks", { blocks: BlockKit.make([ChooseOne]) })

  const Sent = Schema.String.check(Schema.isPattern(/^sent as message /))

  /** The id of the message the last send_user_message with a block sent. */
  const sentId = (request: Scripted.Request) =>
    Scripted.toolResults(request)
      .flatMap((part) => (Schema.is(Sent)(part.result) ? [part.result.slice("sent as message ".length)] : []))
      .at(-1) ?? ""

  const blockScript: Scripted.Script = (request) => {
    const last = Scripted.lastInput(request)

    if (Option.isSome(Scripted.lastResult(request, "send_user_message"))) return Scripted.wait()

    if (last.includes("<answer")) return Scripted.reply(last.includes("blue") ? "Blue it is." : "Red it is.")

    if (last === "blue")
      return [
        Scripted.call("send_user_message", {
          text: "Blue it is.",
          wait: true,
          closes: [sentId(request)]
        })
      ]

    return [
      Scripted.call("send_user_message", {
        text: "Red or blue?",
        wait: false,
        block: { kind: "choose_one", props: { options: ["red", "blue"] } }
      })
    ]
  }

  const layer = runMemory(BlockAssistant.toLayer(simple({ instructions })), Scripted.layer(blockScript))

  const shown = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) =>
      Predicate.isTagged(event, "AssistantMessage") && event.block !== undefined ? [event] : []
    )[0]

  it.live("shows a block; its answer is an input, and closes it", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* BlockAssistant).submit(chat, say("Pick a banner color."))
      const first = yield* collectUntil(BlockAssistant, chat, (es) => shown(es) !== undefined && idle(es))
      const message = shown(first)

      expect(message?.block?.kind).toBe("choose_one")

      // The client renders the block and the user picks blue: `respond` builds the answer.
      const answers: Array<AssistantEvent.BlockAnswer> = []

      const render = BlockKit.toClient(BlockKit.make([ChooseOne]), {
        choose_one: ({ respond }) => respond({ choice: "blue" })
      })

      render(
        viewedMessages(first).find(({ id }) => id === message!.id)!,
        { respond: (answer) => answers.push(answer) }
      )
      yield* (yield* BlockAssistant).submit(chat, answers[0]!)

      const entries = yield* collectUntil(BlockAssistant, chat, (es) => text(es).includes("blue it is") && idle(es))
      const state = BlockKit.fromEntries(entries).get(message!.id)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(state?.open).toBe(false)
      expect(state?.answer?.value).toEqual({ choice: "blue" })
    }).pipe(Effect.provide(layer))
  )

  it.live("takes a block's answer the server submits with Block.answer, once, as an input", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* BlockAssistant).submit(chat, say("Pick a banner color."))
      const first = yield* collectUntil(BlockAssistant, chat, (es) => shown(es) !== undefined && idle(es))
      const messageId = shown(first)!.id

      // An API that acted on the block records its answer; the client's respond sends the same one.
      const answer = Block.answer(ChooseOne, { messageId, value: { choice: "blue" } })
      yield* (yield* BlockAssistant).submit(chat, answer)
      yield* (yield* BlockAssistant).submit(chat, answer)

      const entries = yield* collectUntil(BlockAssistant, chat, (es) => text(es).includes("blue it is") && idle(es))
      const block = viewedMessages(entries).find(({ id }) => id === messageId)?.block

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(entries.filter(({ event }) => Predicate.isTagged(event, "BlockAnswer"))).toHaveLength(1)
      expect(block?.status).toBe("answered")
      expect(block?.answer).toEqual({ choice: "blue" })
    }).pipe(Effect.provide(layer))
  )

  it.live("closes a block the user answered by typing, through `closes`", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* BlockAssistant).submit(chat, say("Pick a banner color."))
      const first = yield* collectUntil(BlockAssistant, chat, (es) => shown(es) !== undefined && idle(es))
      yield* (yield* BlockAssistant).submit(chat, say("blue"))

      const entries = yield* collectUntil(BlockAssistant, chat, (es) => text(es).includes("blue it is") && idle(es))
      const state = BlockKit.fromEntries(entries).get(shown(first)!.id)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(state).toEqual({ open: false, answer: undefined })
    }).pipe(Effect.provide(layer))
  )

  it.live("refuses props that don't fit the block, as a result the model sees, and the turn goes on", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make((request) =>
        Option.isSome(Scripted.lastResult(request, "send_user_message"))
          ? Scripted.reply("Red or blue?")
          : [
              Scripted.call("send_user_message", {
                text: "Pick",
                wait: true,
                block: { kind: "choose_one", props: { options: 3 } }
              })
            ]
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* BlockAssistant).submit(chat, say("Pick a banner color."))

        return yield* collectUntil(BlockAssistant, chat, idle)
      }).pipe(Effect.provide(runMemory(BlockAssistant.toLayer(simple({ instructions })), model.layer)))

      const results = entries.flatMap(({ event }) => (Predicate.isTagged(event, "ToolResult") ? [event] : []))

      expect(results[0]?.outcome).toBe("failure")
      expect(results[0]?.reason).toBe("ToolParameterValidationError")
      expect(toJsonText(results[0]?.result)).toMatch(/Expected/)
      expect(shown(entries)).toBeUndefined()
      // The failed message's `wait` doesn't end the turn: the loop's next step reads the failure.
      expect((yield* model.requests).map((request) => request.toolChoice)).toEqual(["auto", "auto"])
    })
  )
})

describe("the cluster engine", () => {
  it.live("runs a chat as an entity", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* TestAssistant).submit(chat, say("hi"))
      const entries = yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(AssistantEvent.assistantTexts(entries)).toEqual(["Hi."])
    }).pipe(
      Effect.provide(
        runEntity(
          TestAssistant.toLayer(simple({ instructions })),
          Scripted.layer(() => Scripted.reply("Hi."))
        )
      )
    )
  )

  it.live("runs a specialist in the chat's entity, and relays its report once", () =>
    Effect.gen(function* () {
      const chat = yield* newChat
      yield* (yield* ResearchAssistant).submit(chat, say("What's the capital of Canada?"))

      const entries = yield* collectUntil(
        ResearchAssistant,
        chat,
        (es) => text(es).includes("ottawa") && notWorking(es)
      )

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(finished(entries).map((run) => run.status)).toEqual(["answered"])
      // The report may land within the first turn, before its next step: either way it's relayed once.
      expect(AssistantEvent.assistantTexts(entries).filter((message) => message === "It's Ottawa.")).toHaveLength(1)
    }).pipe(Effect.provide(runEntity(researchHandlers, Scripted.layer(researchScript))))
  )
})

describe("tools found on demand, and skills", () => {
  const Parking = Tool.make("parking_availability", {
    description: "Free parking spots at an office garage right now.",
    parameters: Schema.Struct({ office: Schema.String }),
    success: Schema.Struct({ office: Schema.String, freeSpots: Schema.Int })
  })

  const Invoices = Tool.make("invoice_lookup", {
    description: "Find an invoice by number.",
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.String
  })

  const officeTools = withHandlers(Toolkit.make(Parking, Invoices), {
    parking_availability: ({ office }) => Effect.succeed({ office, freeSpots: 37 }),
    invoice_lookup: () => Effect.succeed("not relevant")
  })

  const officeToolsDiscovery = ToolDiscovery.make(officeTools.toolkit)
  // From its own `make` call: the handlers are found by tool name.
  const officeToolsDiscoveryLive = ToolDiscovery.layer(officeTools.toolkit)

  it.live("finds a tool with search_tools and runs it with execute_tool", () =>
    Effect.gen(function* () {
      const script: Scripted.Script = (request) => {
        const found = Scripted.lastResult(request, "search_tools")
        const ran = Scripted.lastResult(request, "execute_tool")

        if (Option.isSome(ran)) return Scripted.reply(ran.value)

        if (Option.isSome(found)) {
          return found.value.includes("parking_availability")
            ? [
                Scripted.call("execute_tool", {
                  name: "parking_availability",
                  input: { office: "Amsterdam" }
                })
              ]
            : Scripted.reply("Not found.")
        }

        return [Scripted.call("search_tools", { query: "free parking spots" })]
      }

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("Any parking free in Amsterdam?"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(
        Effect.provide(
          runMemory(
            TestAssistant.toLayer((turn) => turn.loop({ instructions, toolkit: officeToolsDiscovery })).pipe(
              Layer.provide(
                officeToolsDiscoveryLive.pipe(Layer.provide(officeTools.toolkit.toLayer(officeTools.handlers)))
              )
            ),
            Scripted.layer(script)
          )
        )
      )

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(toolsRun(entries)).toEqual(["search_tools", "execute_tool", "send_user_message"])
      expect(text(entries)).toContain("37")
    })
  )

  it.live("fails execute_tool when its tool fails, so a waiting message doesn't end the turn", () =>
    Effect.gen(function* () {
      const BrokenPrinter = Tool.make("broken_printer", {
        description: "Prints, when it works.",
        success: Schema.String,
        failure: ToolFailure.ToolFailure
      })

      const broken = withHandlers(Toolkit.make(BrokenPrinter), {
        broken_printer: () => ToolFailure.fail("Out of paper.")
      })

      const brokenDiscovery = ToolDiscovery.make(broken.toolkit)
      const brokenDiscoveryLive = ToolDiscovery.layer(broken.toolkit)

      const model = yield* Scripted.make((request) =>
        Option.isSome(Scripted.result(request, "execute_tool"))
          ? Scripted.wait()
          : [Scripted.call("execute_tool", { name: "broken_printer", input: {} }), ...Scripted.reply("Printed.")]
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("Print it."))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(
        Effect.provide(
          runMemory(
            TestAssistant.toLayer((turn) => turn.loop({ instructions, toolkit: brokenDiscovery })).pipe(
              Layer.provide(brokenDiscoveryLive.pipe(Layer.provide(broken.toolkit.toLayer(broken.handlers))))
            ),
            model.layer
          )
        )
      )

      // The model got another step to read the failure, stored as the tool's.
      expect(yield* model.requests).toHaveLength(2)
      expect(
        entries.flatMap(({ event }) =>
          Predicate.isTagged(event, "ToolResult") && event.tool === "execute_tool"
            ? [[event.outcome, event.reason]]
            : []
        )
      ).toEqual([["failure", "ToolFailure"]])
    })
  )
})
