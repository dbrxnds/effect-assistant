import { describe, expect, it } from "@effect/vitest"
import { AssistantActivity, AssistantEvent, ChatId, InputId, RunId } from "../src/index.ts"
import { fact, say } from "./fixtures.ts"

const { SpecialistFinished, SpecialistStarted, TurnCompleted, TurnFailed, TurnStarted } = AssistantEvent

const chatId = ChatId.make()

const entries = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: (i + 1) * 1000, event }))

const activity = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  AssistantActivity.fromEntries(entries(events))

describe("AssistantActivity", () => {
  it("is idle for an empty chat", () => {
    expect(AssistantActivity.isWorking(activity([]))).toBe(false)
  })

  it("works from an input until a turn that read it ends", () => {
    expect(activity([say("hi")]).queued).toBe(true)
    expect(AssistantActivity.isWorking(activity([say("hi")]))).toBe(true)

    // The turn read through seq 2; "two" (seq 3) arrived after, so another turn is coming.
    const events = [say("one"), TurnStarted.make({}), say("two")]

    expect(AssistantActivity.isWorking(activity([...events, TurnCompleted.make({ throughSeq: 2 })]))).toBe(true)
    expect(AssistantActivity.isWorking(activity([...events, TurnCompleted.make({ throughSeq: 3 })]))).toBe(false)
  })

  it("works from TurnStarted until the turn ends", () => {
    const running = activity([say("hi"), TurnStarted.make({})])

    expect(running.turnSince).toBe(2000)
    expect(AssistantActivity.isWorking(running)).toBe(true)
    expect(
      AssistantActivity.isWorking(activity([say("hi"), TurnStarted.make({}), TurnCompleted.make({ throughSeq: 2 })]))
    )
      .toBe(false)
  })

  it("closes a turn a restart cut off when the resumed turn ends", () => {
    const resumed = activity([
      say("hi"),
      TurnStarted.make({}),
      TurnStarted.make({}),
      TurnFailed.make({ throughSeq: 3, message: "boom" })
    ])

    expect(AssistantActivity.isWorking(resumed)).toBe(false)
  })

  it("keeps working while a specialist runs after its turn ended", () => {
    const runId = RunId.make()

    const spawned = [
      say("research this"),
      TurnStarted.make({}),
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
        id: InputId.make(`${runId}:1`),
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
        id: InputId.make(`${runId}:1`),
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

  it("doesn't count a workflow waiting on an approval as work, once its fact is handled", () => {
    const waiting = activity([
      say("request the campaign"),
      TurnStarted.make({}),
      TurnCompleted.make({ throughSeq: 2 }),
      fact("workflow:CampaignRequest", { status: "awaiting_admin_approval" }),
      TurnStarted.make({}),
      TurnCompleted.make({ throughSeq: 5 })
    ])

    expect(AssistantActivity.isWorking(waiting)).toBe(false)
  })
})
