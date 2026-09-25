import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import {
  Assistant,
  AssistantActivity,
  AssistantEngine,
  AssistantEvent,
  Block,
  BlockKit,
  ChatLog,
  InputId,
  Skill,
  Specialist,
  ToolDiscovery
} from "../src/index.ts"
import {
  collectUntil,
  fact,
  failures,
  finished,
  idle,
  layerModel,
  layerStorage,
  memoryAssistant,
  newChat,
  notWorking,
  runEntity,
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

const weather = Tool.make({
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  run: ({ city }) => Effect.succeed({ city, weather: "hail, 3 degrees celsius" })
})

const slowLookup = Tool.make({
  name: "lookup_order",
  description: "Look up the status of an order by id. Takes a few seconds.",
  inputSchema: Schema.Struct({ orderId: Schema.String }),
  run: ({ orderId }) => Effect.sleep("4 seconds").pipe(Effect.as({ orderId, status: "shipped", carrier: "DHL" }))
})

const Research = Specialist.make("research", { description: "Answers factual research questions." })

const ResearchLive = Research.toLayer((run) =>
  run.loop({ model: testModel, instructions: "Answer the question in one sentence." })
)

const ResearchAssistant = Assistant.make("research-test", { specialists: [Research] })

const instructions = "You help a small marketing team. Be brief."

const assistantLayer = <Tools extends Toolkit.Toolkit = Record<never, never>>(toolkit?: Tools) =>
  memoryAssistant(simple({ instructions, toolkit }))

const researchLayer = runMemory(ResearchAssistant.toLayer(simple({ instructions })).pipe(Layer.provide(ResearchLive)))

const SpecialistArgs = Schema.fromJsonString(
  Schema.Struct({
    goal: Schema.optional(Schema.String),
    runId: Schema.optional(Schema.String)
  })
)

/** Calls the assistant made to its specialist tools, with their arguments. */
const specialistCalls = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.flatMap(({ event }) =>
    Predicate.isTagged(event, "ModelOutput")
      ? event.items.flatMap((item) =>
          item.type === "function_call" && item.name.endsWith("_specialist")
            ? [{ name: item.name, args: Schema.decodeUnknownSync(SpecialistArgs)(item.arguments) }]
            : []
        )
      : []
  )

describe("layerMemory", () => {
  it.live("answers a message through send_user_message", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("Say hi in one short message."))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(AssistantEvent.assistantTexts(entries).length).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(assistantLayer()))
  )

  it.live("uses a tool and reports its result", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("What's the weather in Oslo right now?"))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(toolsRun(entries)).toContain("get_weather")
      expect(text(entries)).toContain("hail")
    }).pipe(Effect.provide(assistantLayer(Toolkit.make(weather))))
  )

  it.live("picks up a message sent while it is working", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("Can you check order A-17 for me?"))
      // Wait until the slow tool is running, then send another message.
      yield* collectUntil(assistant, chat, (es) => es.some(({ event }) => Predicate.isTagged(event, "ModelOutput")))
      yield* assistant.submit(chat, say("Also, what's 12 times 12?"))

      const entries = yield* collectUntil(
        assistant,
        chat,
        (es) => text(es).includes("144") && text(es).includes("shipped")
      )

      expect(failures(entries), traceEntries(entries)).toEqual([])
    }).pipe(Effect.provide(assistantLayer(Toolkit.make(slowLookup))))
  )

  it.live("background specialist reports back as a fact and the assistant follows up", () =>
    Effect.gen(function* () {
      const assistant = ResearchAssistant
      const chat = yield* newChat()
      yield* assistant.submit(
        chat,
        say("Start the research specialist in the background: which planet is the largest in our solar system?")
      )

      const entries = yield* collectUntil(
        assistant,
        chat,
        (es) => finished(es).length > 0 && text(es).includes("jupiter")
      )

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(finished(entries).map((run) => [run.specialist, run.status])).toEqual([["research", "answered"]])
    }).pipe(Effect.provide(researchLayer))
  )

  it.live("spawns a specialist for a quick question and relays the answer", () =>
    Effect.gen(function* () {
      const assistant = ResearchAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("Quickly ask the research specialist what the capital of Canada is."))
      const entries = yield* collectUntil(assistant, chat, (es) => text(es).includes("ottawa") && idle(es))

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(toolsRun(entries)).toContain("spawn_specialist")
    }).pipe(Effect.provide(researchLayer))
  )
})

describe("specialist briefs and follow-ups", () => {
  it.live("sends a structured brief and follows up on the same run", () =>
    Effect.gen(function* () {
      const assistant = ResearchAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("Quickly ask the research specialist what the capital of Canada is."))
      const first = yield* collectUntil(assistant, chat, (es) => text(es).includes("ottawa") && idle(es))
      const [call] = specialistCalls(first)

      expect(call?.name).toBe("spawn_specialist")
      expect(call?.args.goal).toEqual(expect.any(String))

      yield* assistant.submit(chat, say("Follow up with that same research run: which province is it in?"))
      const second = yield* collectUntil(assistant, chat, (es) => text(es).includes("ontario") && idle(es))
      const followUp = specialistCalls(second).at(-1)

      expect(failures(second), traceEntries(second)).toEqual([])
      expect(followUp?.name).toBe("message_specialist")
      expect(followUp?.args.runId).toMatch(/^run:/)
    }).pipe(Effect.provide(researchLayer))
  )
})

describe("steering and stopping a running specialist", () => {
  // A slow lookup keeps the specialist busy long enough to steer or stop it.
  const archive = Tool.make({
    name: "search_archive",
    description: "Search the company archive. Slow.",
    inputSchema: Schema.Struct({ query: Schema.String }),
    run: ({ query }) =>
      Effect.sleep("6 seconds").pipe(
        Effect.as({ query, results: ["2024 offsite: Lisbon", "2025 offsite: Porto", "2023 offsite: Berlin"] })
      )
  })

  const Archivist = Specialist.make("archivist", { description: "Looks things up in the company archive." })

  const ArchivistLive = Archivist.toLayer((run) =>
    run.loop({
      model: testModel,
      instructions: "Use search_archive, then answer briefly. Follow any new instructions you get.",
      toolkit: Toolkit.make(archive)
    })
  )

  const ArchiveAssistant = Assistant.make("archive-test", { specialists: [Archivist] })

  const archiveHandlers = ArchiveAssistant.toLayer(simple({ instructions: "You help a small team. Be brief." }))

  const archiveLayer = runMemory(archiveHandlers.pipe(Layer.provide(ArchivistLive)))

  const Status = Schema.fromJsonString(Schema.Struct({ status: Schema.String }))

  const statuses = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) =>
      Predicate.isTagged(event, "ToolResult") && event.tool.endsWith("_specialist")
        ? [Schema.decodeUnknownSync(Status)(event.output).status]
        : []
    )

  it.live("steers a running worker with a new brief", () =>
    Effect.gen(function* () {
      const assistant = ArchiveAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("Have the archivist find where our 2024 offsite was."))
      yield* collectUntil(assistant, chat, (es) => statuses(es).includes("started"))
      yield* assistant.submit(chat, say("Oh, and tell the archivist to also find the 2025 one, same run."))

      const entries = yield* collectUntil(
        assistant,
        chat,
        (es) => text(es).includes("lisbon") && text(es).includes("porto") && idle(es)
      )

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(statuses(entries)).toContain("steered")
    }).pipe(Effect.provide(archiveLayer))
  )

  it.live("stops a running worker", () =>
    Effect.gen(function* () {
      const assistant = ArchiveAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("Have the archivist find where our 2024 offsite was."))
      yield* collectUntil(assistant, chat, (es) => statuses(es).includes("started"))
      yield* assistant.submit(chat, say("Actually never mind, stop the archivist."))
      yield* collectUntil(assistant, chat, (es) => toolsRun(es).includes("stop_specialist"))
      // Give a stopped run time to (wrongly) report back.
      yield* Effect.sleep("10 seconds")
      const log = yield* ChatLog.ChatLog
      const entries = yield* log.read(chat)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      // A stopped run reports that it stopped, and nothing else.
      expect(finished(entries).map((run) => run.status)).toEqual(["stopped"])
      expect(AssistantActivity.isWorking(AssistantActivity.fromEntries(entries))).toBe(false)
    }).pipe(Effect.provide(archiveLayer))
  )

  it.live("closes a run cut off by a shutdown and tells the assistant", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* newChat()

      // The engine and the assistant live in this scope; closing it is the shutdown. The storage stays.
      const layer = archiveHandlers.pipe(
        Layer.provide(ArchivistLive),
        Layer.provideMerge(AssistantEngine.layerMemory),
        Layer.provide(layerModel)
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)

          yield* Effect.gen(function* () {
            yield* ArchiveAssistant.submit(chat, say("Have the archivist find where our 2024 offsite was."))
            yield* collectUntil(ArchiveAssistant, chat, (es) => statuses(es).includes("started"))
          }).pipe(Effect.provide(context))
        })
      )

      const entries = yield* log.read(chat)
      const started = entries.filter(({ event }) => Predicate.isTagged(event, "SpecialistStarted"))

      expect(started).toHaveLength(1)
      expect(AssistantActivity.fromEntries(entries).specialists.size).toBe(0)
      expect(finished(entries).map((run) => run.status)).toEqual(["cut_off"])
    }).pipe(Effect.provide(layerStorage))
  )
})

describe("UI blocks", () => {
  const ChooseOne = Block.make("choose_one", {
    description: "Let the user pick one of a few options with buttons.",
    props: Schema.Struct({ options: Schema.Array(Schema.String) }),
    answer: Schema.Struct({ choice: Schema.String })
  })

  const Confirm = Block.make("confirm", {
    description: "Ask the user to confirm or deny something.",
    props: Schema.Struct({ confirmLabel: Schema.String }),
    answer: Schema.Struct({ confirmed: Schema.Boolean })
  })

  const BlockAssistant = Assistant.make("blocks", { blocks: BlockKit.make([ChooseOne, Confirm]) })

  const layer = BlockAssistant.toLayer(
    simple({
      instructions: "You help a small marketing team. Be brief. Ask for approvals with a confirm block."
    })
  ).pipe((handlers) => runMemory(handlers))

  const withBlock = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) =>
      Predicate.isTagged(event, "AssistantMessage") && event.block !== undefined ? [event] : []
    )[0]

  it.live("puts a block in a message, then acts on its answer", () =>
    Effect.gen(function* () {
      const assistant = BlockAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("Should the campaign banner be red or blue? Give me buttons to pick."))
      const shown = yield* collectUntil(assistant, chat, (es) => withBlock(es) !== undefined && turnsDone(es) >= 1)
      const message = withBlock(shown)!

      expect(message.block!.kind).toBe("choose_one")
      expect(message.text.length).toBeGreaterThan(0)

      yield* assistant.submit(
        chat,
        AssistantEvent.BlockAnswer.make({
          id: InputId.make(),
          messageId: message.id,
          kind: "choose_one",
          value: { choice: "blue" }
        })
      )
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 2 && text(es).includes("blue"))

      expect(failures(entries), traceEntries(entries)).toEqual([])
    }).pipe(Effect.provide(layer))
  )

  it.live("takes a block answered by typing", () =>
    Effect.gen(function* () {
      const assistant = BlockAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("Should the campaign banner be red or blue? Give me buttons to pick."))
      yield* collectUntil(assistant, chat, (es) => withBlock(es) !== undefined && turnsDone(es) >= 1)

      const answer = say("blue")
      yield* assistant.submit(chat, answer)

      // A turn that read the typed answer ended: the first message may have had more than one turn.
      const entries = yield* collectUntil(assistant, chat, (es) => {
        const at = es.find(({ event }) => AssistantEvent.isInput(event) && event.id === answer.id)?.seq

        return at !== undefined && es.some(({ event }) => AssistantEvent.isTurnEnd(event) && event.throughSeq >= at)
      })

      // The assistant usually closes the block too (`closes`), but may not: `staleAfter` covers that.
      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(text(entries)).toContain("blue")
    }).pipe(Effect.provide(layer))
  )

  it.live("fills in a block from a fact", () =>
    Effect.gen(function* () {
      const assistant = BlockAssistant
      const chat = yield* newChat()
      yield* assistant.submit(
        chat,
        fact("workflow:CreateCampaign", {
          status: "needs_approval",
          campaign: "Spring promo",
          budget: 4800,
          currency: "EUR",
          next: "Get the user's approval for the budget."
        })
      )
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)
      // The host only says what it needs; the assistant writes the message and fills in the block.
      const message = withBlock(entries)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(message?.block?.kind).toBe("confirm")
      expect(JSON.stringify(message)).toMatch(/4[.,]?8(00|k)/i)
    }).pipe(Effect.provide(layer))
  )
})

describe("facts: tell the user or keep it internal", () => {
  it.live("keeps routine progress internal", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat()
      yield* assistant.submit(
        chat,
        fact("workflow:InventorySync", { step: "3 of 10", status: "syncing", detail: "routine batch, nothing needed" })
      )
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(AssistantEvent.assistantTexts(entries)).toEqual([])
    }).pipe(Effect.provide(assistantLayer()))
  )

  it.live("tells the user when something needs them", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat()
      yield* assistant.submit(
        chat,
        fact("workflow:InventorySync", {
          status: "blocked",
          detail: "The supplier rejected the order: the shipping address is missing. The user must provide one."
        })
      )
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(text(entries)).toContain("address")
    }).pipe(Effect.provide(assistantLayer()))
  )
})

const clusterLayer = runEntity(TestAssistant.toLayer(simple({ instructions: "You help a small team. Be brief." })))

const researchClusterLayer = runEntity(
  ResearchAssistant.toLayer(simple({ instructions: "You help a small team. Be brief." })).pipe(
    Layer.provide(ResearchLive)
  )
)

describe("layerEntity", () => {
  it.live("runs a chat as a cluster entity", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("Say hi in one short message."))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(AssistantEvent.assistantTexts(entries).length).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(clusterLayer))
  )

  it.live("runs a background specialist and reports back once", () =>
    Effect.gen(function* () {
      const assistant = ResearchAssistant
      const chat = yield* newChat()
      yield* assistant.submit(
        chat,
        say("Start the research specialist in the background: which planet is the largest in our solar system?")
      )

      // The fact may land while the first turn still runs; then that turn relays it.
      const entries = yield* collectUntil(
        assistant,
        chat,
        (es) => finished(es).length > 0 && text(es).includes("jupiter") && notWorking(es)
      )

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(finished(entries).map((run) => run.specialist)).toEqual(["research"])
      expect(entries.filter(({ event }) => Predicate.isTagged(event, "SpecialistStarted"))).toHaveLength(1)
    }).pipe(Effect.provide(researchClusterLayer))
  )
})

describe("discovery", () => {
  const filler = (name: string, description: string) =>
    Tool.make({
      name,
      description,
      inputSchema: Schema.Struct({ id: Schema.String }),
      run: () => Effect.succeed("not relevant")
    })

  const parking = Tool.make({
    name: "parking_availability",
    description: "Free parking spots at an office garage right now.",
    inputSchema: Schema.Struct({ office: Schema.String }),
    run: ({ office }) => Effect.succeed({ office, freeSpots: 37 })
  })

  const catalog = [
    parking,
    filler("invoice_lookup", "Find an invoice by number."),
    filler("payroll_run", "Start a payroll run for a month."),
    filler("brand_assets", "Download logos and brand files."),
    filler("printer_status", "Status of office printers."),
    filler("vendor_contacts", "Contact details for vendors."),
    filler("expense_report", "Submit an expense report."),
    filler("meeting_rooms", "Book a meeting room."),
    filler("holiday_calendar", "Public holidays per country."),
    filler("it_ticket", "Open an IT support ticket."),
    filler("contract_search", "Search signed contracts."),
    filler("travel_booking", "Book flights and hotels.")
  ]

  it.live("finds a tool with search_tools and runs it with execute_tool", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("How many parking spots are free at the Amsterdam office right now?"))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(toolsRun(entries)).toContain("search_tools")
      expect(toolsRun(entries)).toContain("execute_tool")
      expect(text(entries)).toContain("37")
    }).pipe(Effect.provide(assistantLayer(ToolDiscovery.make(Toolkit.fromArray(catalog)))))
  )

  it.live("loads a skill from its catalog and follows it", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat()
      yield* assistant.submit(chat, say("We have a new hire starting Monday. What's our onboarding process?"))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(toolsRun(entries)).toContain("load_skill")
      expect(text(entries)).toContain("buddy")
    }).pipe(
      Effect.provide(
        memoryAssistant(
          simple({
            instructions: "You help an office team. Be brief.",
            skills: [
              Skill.make({
                name: "Onboarding",
                description: "Use when someone new is joining the team.",
                instructions: "1. Send the welcome pack. 2. Book a buddy lunch on day one. 3. Set up their laptop."
              }),
              Skill.make({
                name: "Offboarding",
                description: "Use when someone is leaving.",
                instructions: "Collect the laptop."
              })
            ]
          })
        )
      )
    )
  )
})
