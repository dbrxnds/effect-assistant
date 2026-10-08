import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { AssistantActivity, AssistantEvent, ChatId, DecisionId, InputId, RunId } from "../src/index.ts"
import { say, storedUpdate } from "./utils/fixtures.ts"

const { SpecialistFinished, SpecialistStarted, TurnCompleted, TurnFailed, TurnStarted } = AssistantEvent

const chatId = Effect.runSync(ChatId.make)

const entries = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: (i + 1) * 1000, event }))

const activity = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  AssistantActivity.fromEntries(entries(events))

describe("AssistantActivity", () => {
  it("works from an input until a turn that read it ends", () => {
    expect(activity([say("hi")]).queued).toBe(true)
    expect(AssistantActivity.isWorking(activity([say("hi")]))).toBe(true)

    // The turn read through seq 2; "two" (seq 3) arrived after, so another turn is coming.
    const events = [say("one"), TurnStarted.make({ assistant: "test" }), say("two")]

    expect(AssistantActivity.isWorking(activity([...events, TurnCompleted.make({ throughSeq: 2 })]))).toBe(true)
    expect(AssistantActivity.isWorking(activity([...events, TurnCompleted.make({ throughSeq: 3 })]))).toBe(false)
  })

  it("works from TurnStarted until the turn ends", () => {
    const running = activity([say("hi"), TurnStarted.make({ assistant: "test" })])

    expect(running.turnSince).toBe(2000)
    expect(AssistantActivity.isWorking(running)).toBe(true)
    expect(
      AssistantActivity.isWorking(
        activity([say("hi"), TurnStarted.make({ assistant: "test" }), TurnCompleted.make({ throughSeq: 2 })])
      )
    ).toBe(false)
  })

  it("closes a turn a restart cut off when the resumed turn ends", () => {
    const resumed = activity([
      say("hi"),
      TurnStarted.make({ assistant: "test" }),
      TurnStarted.make({ assistant: "test" }),
      TurnFailed.make({ throughSeq: 3, message: "boom" })
    ])

    expect(AssistantActivity.isWorking(resumed)).toBe(false)
  })

  it("keeps working while a specialist runs after its turn ended", () => {
    const runId = RunId.fromKey("activity-test")

    const spawned = [
      say("research this"),
      TurnStarted.make({ assistant: "test" }),
      SpecialistStarted.make({ runId, specialist: "research", goal: "Q4 budgets" })
    ]

    const afterTurn = activity([...spawned, TurnCompleted.make({ throughSeq: 3 })])

    expect(afterTurn.turnSince).toBeUndefined()
    expect([...afterTurn.specialists.values()]).toEqual([
      { runId, specialist: "research", goal: "Q4 budgets", since: 3000 }
    ])
    expect(AssistantActivity.isWorking(afterTurn)).toBe(true)

    const answered = activity([
      ...spawned,
      TurnCompleted.make({ throughSeq: 3 }),
      SpecialistFinished.make({
        id: InputId.fromKey(`${runId}:1`),
        runId,
        specialist: "research",
        brief: 1,
        goal: "Q4 budgets",
        status: "answered",
        report: "done"
      })
    ])

    // The report ends the run, and a turn will read it.
    expect(answered.specialists.size).toBe(0)
    expect(answered.queued).toBe(true)

    const stopped = activity([
      ...spawned,
      TurnCompleted.make({ throughSeq: 3 }),
      SpecialistFinished.make({
        id: InputId.fromKey(`${runId}:1`),
        runId,
        specialist: "research",
        brief: 1,
        goal: "Q4 budgets",
        status: "stopped"
      })
    ])

    // A run the assistant stopped starts no turn.
    expect(stopped.specialists.size).toBe(0)
    expect(AssistantActivity.isWorking(stopped)).toBe(false)
  })

  it("doesn't count a workflow waiting on an approval as work, once its request is handled", () => {
    const waiting = activity([
      say("request the campaign"),
      TurnStarted.make({ assistant: "test" }),
      TurnCompleted.make({ throughSeq: 2 }),
      AssistantEvent.DecisionRequested.make({
        id: DecisionId.fromKey("campaign-approval"),
        origin: AssistantEvent.WorkOrigin.make({ source: "workflow:CampaignRequest" }),
        preview: { campaign: "Spring" }
      }),
      TurnStarted.make({ assistant: "test" }),
      TurnCompleted.make({ throughSeq: 5 })
    ])

    expect(AssistantActivity.isWorking(waiting)).toBe(false)
  })

  it("counts an app event that wakes a turn as an input, given its tag", () => {
    const events = [
      say("order it"),
      TurnStarted.make({ assistant: "test" }),
      TurnCompleted.make({ throughSeq: 2 }),
      storedUpdate("workflow:Order", { status: "shipped" })
    ]

    const stored = events.map((event, i) => ({ chatId, seq: i + 1, at: (i + 1) * 1000, event }))

    expect(AssistantActivity.isWorking(AssistantActivity.fromEntries(stored))).toBe(false)
    expect(AssistantActivity.isWorking(AssistantActivity.fromEntries(stored, { wakes: new Set(["Update"]) }))).toBe(
      true
    )
  })
})
