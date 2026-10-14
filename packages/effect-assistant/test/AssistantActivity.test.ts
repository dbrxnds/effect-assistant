import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { AssistantActivity, AssistantEvent, ChatId, InputId, RunId } from "../src/index.ts"
import { say, storedUpdate, submittedUpdate } from "./utils/fixtures.ts"

const { SpecialistFinished, SpecialistStarted, TurnCompleted, TurnFailed, TurnStarted } = AssistantEvent

const chatId = Effect.runSync(ChatId.make())

const entries = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, sequence: i + 1, at: (i + 1) * 1000, event }))

const activity = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  AssistantActivity.fromEntries(entries(events))

describe("AssistantActivity", () => {
  it("works from an input until a turn that read it ends", () => {
    expect(activity([say("hi")]).queued).toBe(true)
    expect(AssistantActivity.isWorking(activity([say("hi")]))).toBe(true)

    // The turn read through sequence 2; "two" (sequence 3) arrived after, so another turn is coming.
    const events = [say("one"), TurnStarted.make({ assistant: "test" }), say("two")]

    expect(AssistantActivity.isWorking(activity([...events, TurnCompleted.make({ throughSequence: 2 })]))).toBe(true)
    expect(AssistantActivity.isWorking(activity([...events, TurnCompleted.make({ throughSequence: 3 })]))).toBe(false)
  })

  it("works from TurnStarted until the turn ends", () => {
    const running = activity([say("hi"), TurnStarted.make({ assistant: "test" })])

    expect(running.turnSince).toBe(2000)
    expect(AssistantActivity.isWorking(running)).toBe(true)
    expect(
      AssistantActivity.isWorking(
        activity([say("hi"), TurnStarted.make({ assistant: "test" }), TurnCompleted.make({ throughSequence: 2 })])
      )
    ).toBe(false)
  })

  it("closes a turn a restart cut off when the resumed turn ends", () => {
    const resumed = activity([
      say("hi"),
      TurnStarted.make({ assistant: "test" }),
      TurnStarted.make({ assistant: "test" }),
      TurnFailed.make({ throughSequence: 3, message: "boom" })
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

    const afterTurn = activity([...spawned, TurnCompleted.make({ throughSequence: 3 })])

    expect(afterTurn.turnSince).toBeUndefined()
    expect([...afterTurn.specialists.values()]).toEqual([
      { runId, specialist: "research", goal: "Q4 budgets", since: 3000 }
    ])
    expect(AssistantActivity.isWorking(afterTurn)).toBe(true)

    const answered = activity([
      ...spawned,
      TurnCompleted.make({ throughSequence: 3 }),
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
      TurnCompleted.make({ throughSequence: 3 }),
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

  it("counts an app event that came in through submit as an input, and not one a turn appended", () => {
    const after = (event: AssistantEvent.StoredAppEvent) =>
      [say("order it"), TurnStarted.make({ assistant: "test" }), TurnCompleted.make({ throughSequence: 2 }), event].map(
        (event, i) => ({ chatId, sequence: i + 1, at: (i + 1) * 1000, event })
      )

    expect(
      AssistantActivity.isWorking(
        AssistantActivity.fromEntries(after(submittedUpdate("workflow:Order", { status: "shipped" })))
      )
    ).toBe(true)
    expect(
      AssistantActivity.isWorking(
        AssistantActivity.fromEntries(after(storedUpdate("workflow:Order", { status: "shipped" })))
      )
    ).toBe(false)
  })
})
