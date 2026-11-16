/**
 * A chat's live signals: a described tool's status while its call runs, the
 * typing indicator while the model writes a message, and a summary status for a
 * turn that works a while with nothing to show. They reach live subscribers in
 * order with the entries, are never stored, and never outlive their turn.
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

const Lookup = Tool.make("lookup", {
  description: "A quick lookup.",
  parameters: Schema.Struct({ campaignId: Schema.String }),
  success: Schema.Struct({ found: Schema.Boolean })
})

const Tools = Toolkit.make(CampaignReport, Lookup)

type Item = Assistant.Entry | ChatSignal.ChatSignal

const isTurnEnd = (item: Item) => !ChatSignal.isChatSignal(item) && AssistantEvent.isTurnEnd(item.event)

/** One line per item: the entries a client shows, and every signal. */
const label = (item: Item): ReadonlyArray<string> => {
  if (!ChatSignal.isChatSignal(item)) {
    const tag = item.event._tag

    return ["TurnStarted", "AssistantMessage", "TurnCompleted", "TurnFailed"].includes(tag) ? [tag] : []
  }

  return [Predicate.isTagged(item, "StatusShown") ? `StatusShown ${item.source}: ${item.text}` : item._tag]
}

/** The tools' handlers, recording the params the report got. */
const harness = Effect.fnUntraced(function* (options: { readonly report: Effect.Effect<void> }) {
  const received = yield* Ref.make<ReadonlyArray<unknown>>([])

  const tools = withHandlers(Tools, {
    campaign_report: (params) =>
      Ref.update(received, (all) => [...all, params]).pipe(Effect.andThen(options.report), Effect.as({ spent: 1200 })),
    lookup: () => Effect.sleep("300 millis").pipe(Effect.as({ found: true }))
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
  it.effect("goes started → status → typing → message → finished, in order with the entries", () =>
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
        `StatusShown tool: ${STATUS}`,
        "StatusCleared",
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

  it.effect("shows the status on the timeline while the call runs, and nothing once the turn ends", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.void })

      const { items } = yield* liveTurn(gate, "What did last summer's campaign cost?").pipe(
        Effect.provide(
          runMemory(TestAssistant.toLayer(gatedHandler(gate, tools.tools)), Scripted.layer(reportThenAnswer))
        )
      )

      const timelines = timelineOf(items)

      expect(timelines.some((timeline) => timeline.activity.status === STATUS)).toBe(true)
      expect(timelines.some((timeline) => timeline.activity.typing)).toBe(true)
      expect(timelines.at(-1)?.activity).toEqual({ working: false, specialists: [], typing: false })
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

  it.effect("clears the status and the typing when the turn fails mid-tool", () =>
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
      expect(labels).toContain(`StatusShown tool: ${STATUS}`)
      expect(labels.indexOf("StatusCleared")).toBeLessThan(labels.indexOf("TurnFailed"))
      expect(labels.lastIndexOf("TypingStopped")).toBeGreaterThan(labels.lastIndexOf("TypingStarted"))
      expect(timelineOf(items).at(-1)?.activity).toMatchObject({ typing: false })
      expect(timelineOf(items).at(-1)?.activity.status).toBeUndefined()
    })
  )

  it.effect("clears what the turn showed when a model call fails after typing started", () =>
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

      const labels = items.flatMap(label)

      expect(labels.at(-1)).toBe("TurnFailed")
      expect(timelineOf(items).at(-1)?.activity).toEqual({ working: false, specialists: [], typing: false })
    })
  )

  it.live("summarizes a turn that works a while with nothing to show, and drops it for the message", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const tools = yield* harness({ report: Effect.void })
      const summaryModel = yield* Scripted.make(() => [Scripted.text("Looking up the campaign")])

      const turnModel = yield* Scripted.make((request) =>
        Option.isNone(Scripted.result(request, "lookup"))
          ? [Scripted.call("lookup", { campaignId: "summer" })]
          : Scripted.reply("Found it.")
      )

      const summary = StatusSummary.layer({ after: "50 millis", every: "50 millis" }).pipe(
        Layer.provide(summaryModel.layer)
      )

      const { items } = yield* liveTurn(gate, "Find last summer's campaign.").pipe(
        Effect.provide(
          runMemory(
            TestAssistant.toLayer(gatedHandler(gate, tools.tools)).pipe(Layer.provide(summary)),
            turnModel.layer
          )
        )
      )

      const labels = items.flatMap(label)
      const shown = labels.indexOf("StatusShown summary: Looking up the campaign")

      expect(shown).toBeGreaterThan(0)
      expect(labels.indexOf("StatusCleared", shown)).toBeLessThan(labels.indexOf("TypingStarted"))
      expect(labels.at(-1)).toBe("TurnCompleted")

      // The summary's model read the turn; the turn's model never read the summary.
      const [read] = yield* summaryModel.requests
      expect(Scripted.lastInput(read!)).toContain("lookup")

      for (const request of yield* turnModel.requests) {
        expect(JSON.stringify(request.history)).not.toContain("Looking up the campaign")
      }
    })
  )

  it.live("shows no summary for what the handler does after the reply", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const summaryModel = yield* Scripted.make(() => [Scripted.text("Tidying up")])

      const summary = StatusSummary.layer({ after: "20 millis", every: "20 millis" }).pipe(
        Layer.provide(summaryModel.layer)
      )

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
            TestAssistant.toLayer(handler).pipe(Layer.provide(summary)),
            Scripted.layer(() => Scripted.reply("Hello."))
          )
        )
      )

      const labels = items.flatMap(label)

      expect(labels.slice(labels.indexOf("AssistantMessage"))).not.toContain("StatusShown summary: Tidying up")
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
        `StatusShown tool: ${STATUS}`,
        "StatusCleared",
        "TypingStarted",
        "AssistantMessage",
        "TypingStopped",
        "TurnCompleted"
      ])
    })
  )
})
