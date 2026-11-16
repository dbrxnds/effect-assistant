/**
 * A chat's live signals: the status line (a described call's own words, or a
 * summary for a turn whose line is empty or stale), and the typing indicator
 * while the model writes a message. They reach live subscribers in order with
 * the entries, are never stored, and never outlive their turn.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  type Assistant,
  AssistantEvent,
  ChatLog,
  ChatSignal,
  StatusSummary,
  Timeline,
  ToolStatus
} from "../src/index.ts"
import { newChat, runEntity, runMemory, say, TestAssistant, withHandlers, withTools } from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const instructions = "You help a small marketing team."

const STATUS = "Checking last summer's campaign budget"

const CampaignReport = ToolStatus.described(
  Tool.make("campaign_report", {
    description: "The spend of a past campaign.",
    parameters: Schema.Struct({ campaignId: Schema.String }),
    success: Schema.Struct({ spent: Schema.Finite })
  })
)

const PLAN = "Drafting the summer campaign plan"

const CampaignPlan = ToolStatus.described(
  Tool.make("campaign_plan", {
    description: "Drafts a campaign plan.",
    parameters: Schema.Struct({ campaignId: Schema.String }),
    success: Schema.Struct({ planned: Schema.Boolean })
  })
)

const Lookup = Tool.make("lookup", {
  description: "A quick lookup.",
  parameters: Schema.Struct({ campaignId: Schema.String }),
  success: Schema.Struct({ found: Schema.Boolean })
})

const Tools = Toolkit.make(CampaignReport, CampaignPlan, Lookup)

type Item = Assistant.Entry | ChatSignal.ChatSignal

const isTurnEnd = (item: Item) => !ChatSignal.isChatSignal(item) && AssistantEvent.isTurnEnd(item.event)

/** One line per item: the entries a client shows, and every signal. */
const label = (item: Item): ReadonlyArray<string> => {
  if (!ChatSignal.isChatSignal(item)) {
    const tag = item.event._tag

    return ["TurnStarted", "AssistantMessage", "TurnCompleted", "TurnFailed"].includes(tag) ? [tag] : []
  }

  return [Predicate.isTagged(item, "Status") ? `Status: ${item.text}` : item._tag]
}

/** The tools' handlers, recording the params the report got. */
const harness = Effect.fnUntraced(function* (options: {
  readonly report: Effect.Effect<void>
  readonly lookup?: Effect.Effect<void>
}) {
  const received = yield* Ref.make<ReadonlyArray<unknown>>([])

  const tools = withHandlers(Tools, {
    campaign_report: (params) =>
      Ref.update(received, (all) => [...all, params]).pipe(Effect.andThen(options.report), Effect.as({ spent: 1200 })),
    campaign_plan: () => Effect.succeed({ planned: true }),
    lookup: () => (options.lookup ?? Effect.sleep("300 millis")).pipe(Effect.as({ found: true }))
  })

  return { received: Ref.get(received), tools }
})

/**
 * A turn that runs once the live subscription is listening, so the test sees every signal: the
 * subscription's first item, the user's message, opens the gate.
 */
const gatedHandler =
  (gate: Deferred.Deferred<void>, tools: ReturnType<typeof withHandlers<typeof Tools.tools>>) =>
  (turn: Assistant.Turn) =>
    Stream.unwrap(Effect.as(Deferred.await(gate), withTools({ instructions, toolkit: tools })(turn)))

const liveTurn = Effect.fnUntraced(function* (gate: Deferred.Deferred<void>, text: string) {
  const assistant = yield* TestAssistant
  const chat = yield* newChat

  const watching = yield* assistant.subscribe(chat, { live: true }).pipe(
    Stream.tap(() => Deferred.succeed(gate, undefined)),
    Stream.takeUntil(isTurnEnd),
    Stream.runCollect,
    Effect.timeout("10 seconds"),
    Effect.forkChild
  )

  yield* assistant.submit(chat, say(text))

  const items = yield* Fiber.join(watching)
  const stored = yield* (yield* ChatLog.ChatLog).read(chat)

  return { items, stored }
})

/** The model: the report with a status, then the answer. */
const reportThenAnswer: Scripted.Script = (request) =>
  Option.isNone(Scripted.result(request, "campaign_report"))
    ? [Scripted.call("campaign_report", { campaignId: "summer", description: STATUS })]
    : Scripted.reply("Last summer's campaign spent 1,200.")

/** The turn's model: these calls first, then the answer. */
const callsThenAnswer =
  (...calls: ReadonlyArray<readonly [string, { readonly [key: string]: Scripted.Json }]>): Scripted.Script =>
  (request) =>
    Option.isNone(Scripted.result(request, calls[0]![0]))
      ? calls.map(([name, params]) => Scripted.call(name, params))
      : Scripted.reply("Done.")

const summarizing = (text: string, options: StatusSummary.Options) =>
  Effect.map(
    Scripted.make(() => [Scripted.text(text)]),
    (model) => ({
      model,
      layer: StatusSummary.layer(options).pipe(Layer.provide(model.layer))
    })
  )

const timelineOf = (items: ReadonlyArray<Item>) =>
  Effect.runSync(
    Stream.fromIterable(items).pipe(
      Stream.rechunk(1),
      Timeline.changes(TestAssistant),
      Timeline.fold,
      Stream.runCollect
    )
  )

describe("ChatSignal", () => {
  it.effect("goes started → status → typing → message → finished; the status stays after its call", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.void })

      const { items, stored } = yield* liveTurn(gate, "What did last summer's campaign cost?").pipe(
        Effect.provide(
          runMemory(TestAssistant.toLayer(gatedHandler(gate, tools.tools)), Scripted.layer(reportThenAnswer))
        )
      )

      expect(items.flatMap(label)).toEqual([
        "TurnStarted",
        `Status: ${STATUS}`,
        "TypingStarted",
        "AssistantMessage",
        "TypingStopped",
        "TurnCompleted"
      ])

      // The handler gets its own params only.
      expect(yield* tools.received).toEqual([{ campaignId: "summer" }])

      // Never stored: the log has no trace of them.
      expect(stored.some(({ event }) => ChatSignal.isChatSignal(event))).toBe(false)
    })
  )

  it.effect("shows the status on the timeline until typing hides it, and nothing once the turn ends", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.void })

      const { items } = yield* liveTurn(gate, "What did last summer's campaign cost?").pipe(
        Effect.provide(
          runMemory(TestAssistant.toLayer(gatedHandler(gate, tools.tools)), Scripted.layer(reportThenAnswer))
        )
      )

      const activities = timelineOf(items).map((timeline) => timeline.activity)
      const typing = activities.findIndex((activity) => activity.typing)

      expect(activities[typing - 1]?.status).toBe(STATUS)
      expect(activities[typing]?.status).toBeUndefined()
      expect(activities.at(-1)).toEqual({ working: false, specialists: [], typing: false })
    })
  )

  it.live("shows the label of a call that still runs when the shown one ends", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.sleep("200 millis") })

      const script = callsThenAnswer(
        ["campaign_report", { campaignId: "summer", description: STATUS }],
        ["campaign_plan", { campaignId: "summer", description: PLAN }]
      )

      const { items } = yield* liveTurn(gate, "Plan the summer campaign.").pipe(
        Effect.provide(runMemory(TestAssistant.toLayer(gatedHandler(gate, tools.tools)), Scripted.layer(script)))
      )

      expect(items.flatMap(label)).toEqual([
        "TurnStarted",
        `Status: ${STATUS}`,
        `Status: ${PLAN}`,
        `Status: ${STATUS}`,
        "TypingStarted",
        "AssistantMessage",
        "TypingStopped",
        "TurnCompleted"
      ])
    })
  )

  it.effect("offers the status parameter only on described tools", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(reportThenAnswer)
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.void })

      yield* liveTurn(gate, "What did it cost?").pipe(
        Effect.provide(runMemory(TestAssistant.toLayer(gatedHandler(gate, tools.tools)), model.layer))
      )

      const [first] = yield* model.requests
      const schemas = first?.parameters ?? new Map<string, unknown>()

      expect(JSON.stringify(schemas.get("campaign_report"))).toContain(ToolStatus.parameterName)
      expect(JSON.stringify(schemas.get("lookup"))).not.toContain(ToolStatus.parameterName)
    })
  )

  it.effect("stops the typing and clears the line when the turn fails mid-tool", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.die("the report service went away") })

      // The model writes to the user and runs the report in the same step: the report fails the turn.
      const script: Scripted.Script = () => [
        Scripted.call("send_user_message", { text: "Looking it up." }),
        Scripted.call("campaign_report", { campaignId: "summer", description: STATUS })
      ]

      const { items } = yield* liveTurn(gate, "What did it cost?").pipe(
        Effect.provide(runMemory(TestAssistant.toLayer(gatedHandler(gate, tools.tools)), Scripted.layer(script)))
      )

      const labels = items.flatMap(label)

      expect(labels.at(-1)).toBe("TurnFailed")
      expect(labels.lastIndexOf("TypingStopped")).toBeGreaterThan(labels.lastIndexOf("TypingStarted"))
      expect(labels.lastIndexOf("TypingStopped")).toBeLessThan(labels.indexOf("TurnFailed"))
      expect(timelineOf(items).at(-1)?.activity).toEqual({ working: false, specialists: [], typing: false })
    })
  )

  it.effect("clears the line when a model call fails after a status", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.void })

      const script: Scripted.Script = (request) => {
        if (Option.isSome(Scripted.result(request, "campaign_report"))) throw new Error("model overloaded")

        return [Scripted.call("campaign_report", { campaignId: "summer", description: STATUS })]
      }

      const { items } = yield* liveTurn(gate, "What did it cost?").pipe(
        Effect.provide(runMemory(TestAssistant.toLayer(gatedHandler(gate, tools.tools)), Scripted.layer(script)))
      )

      expect(items.flatMap(label).at(-1)).toBe("TurnFailed")
      expect(timelineOf(items).at(-1)?.activity).toEqual({ working: false, specialists: [], typing: false })
    })
  )

  it.live("fills an empty line with a summary that knows what runs", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.void })
      const summary = yield* summarizing("Looking up the campaign", { after: "50 millis" })
      const turnModel = yield* Scripted.make(callsThenAnswer(["lookup", { campaignId: "summer" }]))

      const { items } = yield* liveTurn(gate, "Find last summer's campaign.").pipe(
        Effect.provide(
          runMemory(
            TestAssistant.toLayer(gatedHandler(gate, tools.tools)).pipe(Layer.provide(summary.layer)),
            turnModel.layer
          )
        )
      )

      const labels = items.flatMap(label)

      expect(labels.filter((line) => line.startsWith("Status"))).toEqual(["Status: Looking up the campaign"])
      expect(labels.indexOf("Status: Looking up the campaign")).toBeLessThan(labels.indexOf("TypingStarted"))
      expect(labels.at(-1)).toBe("TurnCompleted")

      const reads = yield* summary.model.requests
      expect(reads.some((read) => Scripted.lastInput(read).includes("Running now: lookup"))).toBe(true)

      // The turn's model never reads the summary.
      for (const request of yield* turnModel.requests) {
        expect(JSON.stringify(request.history)).not.toContain("Looking up the campaign")
      }
    })
  )

  it.live("refreshes a call's status that stays after the call while other work runs", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.void, lookup: Effect.sleep("600 millis") })
      const summary = yield* summarizing("Looking up the campaign", { after: "50 millis", staleAfter: "150 millis" })

      const script = callsThenAnswer(
        ["campaign_report", { campaignId: "summer", description: STATUS }],
        ["lookup", { campaignId: "summer" }]
      )

      const { items } = yield* liveTurn(gate, "Find last summer's campaign.").pipe(
        Effect.provide(
          runMemory(
            TestAssistant.toLayer(gatedHandler(gate, tools.tools)).pipe(Layer.provide(summary.layer)),
            Scripted.layer(script)
          )
        )
      )

      expect(items.flatMap(label).filter((line) => line.startsWith("Status") || line === "TypingStarted")).toEqual([
        `Status: ${STATUS}`,
        "Status: Looking up the campaign",
        "TypingStarted"
      ])
    })
  )

  it.live("sends no summary that says what the line says already", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.void, lookup: Effect.sleep("600 millis") })
      const summary = yield* summarizing(STATUS, { after: "50 millis", staleAfter: "100 millis" })

      const script = callsThenAnswer(
        ["campaign_report", { campaignId: "summer", description: STATUS }],
        ["lookup", { campaignId: "summer" }]
      )

      const { items } = yield* liveTurn(gate, "Find last summer's campaign.").pipe(
        Effect.provide(
          runMemory(
            TestAssistant.toLayer(gatedHandler(gate, tools.tools)).pipe(Layer.provide(summary.layer)),
            Scripted.layer(script)
          )
        )
      )

      expect((yield* summary.model.requests).length).toBeGreaterThan(0)
      expect(items.flatMap(label).filter((line) => line.startsWith("Status"))).toEqual([`Status: ${STATUS}`])
    })
  )

  it.live("shows no summary for what the handler does after the reply", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const summary = yield* summarizing("Tidying up", { after: "20 millis", staleAfter: "20 millis" })

      // The reply, then a slow step of the app's own, like writing a summary of the chat.
      const handler = (turn: Assistant.Turn) =>
        Stream.unwrap(
          Effect.as(
            Deferred.await(gate),
            turn.run({ instructions }).pipe(Stream.concat(Stream.drain(Stream.fromEffect(Effect.sleep("300 millis")))))
          )
        )

      const { items } = yield* liveTurn(gate, "Hi").pipe(
        Effect.provide(
          runMemory(
            TestAssistant.toLayer(handler).pipe(Layer.provide(summary.layer)),
            Scripted.layer(() => Scripted.reply("Hello."))
          )
        )
      )

      const labels = items.flatMap(label)

      expect(labels.slice(labels.indexOf("AssistantMessage"))).not.toContain("Status: Tidying up")
      expect(labels.at(-1)).toBe("TurnCompleted")
    })
  )

  it.effect("reaches a live subscriber through the cluster", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.void })

      const { items } = yield* liveTurn(gate, "What did last summer's campaign cost?").pipe(
        Effect.provide(
          runEntity(TestAssistant.toLayer(gatedHandler(gate, tools.tools)), Scripted.layer(reportThenAnswer))
        )
      )

      expect(items.flatMap(label)).toEqual([
        "TurnStarted",
        `Status: ${STATUS}`,
        "TypingStarted",
        "AssistantMessage",
        "TypingStopped",
        "TurnCompleted"
      ])
    })
  )
})
