import * as HistoryCheck from "@effect-uai/core/HistoryCheck"
import type * as Items from "@effect-uai/core/Items"
import { describe, expect, it } from "@effect/vitest"
import * as Match from "effect/Match"
import { AssistantEvent, ChatId, InputId, RunId } from "../src/index.ts"
import * as History from "../src/internal/history.ts"
import { say } from "./fixtures.ts"

const { ModelOutput, ToolResult, ToolStarted, TurnStarted } = AssistantEvent

const chatId = ChatId.make()

const entries = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: 0, event }))

const call = (id: string, name: string): Items.HistoryItem => ({
  type: "function_call",
  call_id: id,
  name,
  arguments: "{}"
})

/** A readable trace: user text, tool calls by name, and tool outputs by call id. */
const trace = (history: ReadonlyArray<Items.HistoryItem>) =>
  history.map((item) =>
    Match.value(item).pipe(
      Match.when(
        { type: "message" },
        (message) => `user: ${message.content.map((content) => ("text" in content ? content.text : "")).join("")}`
      ),
      Match.when({ type: "function_call" }, (call) => `call: ${call.name}`),
      Match.when({ type: "function_call_output" }, (output) => `result: ${output.call_id}`),
      Match.orElse((other) => other.type)
    )
  )

describe("History.fromEntries", () => {
  it("puts a message that arrived while the model was writing after that step", () => {
    // Seq 5 arrives after the step at seq 6 read through seq 4.
    const history = History.fromEntries(
      entries([
        say("what orders does amsterdam have"),
        TurnStarted.make({}),
        ModelOutput.make({ items: [call("a", "order_history")], seenThroughSeq: 2 }),
        ToolResult.make({ callId: "a", tool: "order_history", output: "[]" }),
        say("and do it for amsterdam"),
        ModelOutput.make({ items: [call("b", "send_user_message")], seenThroughSeq: 4 }),
        ToolResult.make({ callId: "b", tool: "send_user_message", output: "sent" })
      ])
    )

    expect(trace(history)).toEqual([
      "user: what orders does amsterdam have",
      "call: order_history",
      "result: a",
      "call: send_user_message",
      "result: b",
      "user: and do it for amsterdam"
    ])
  })

  it("keeps a message the model did see where it arrived", () => {
    const history = History.fromEntries(
      entries([
        say("hi"),
        TurnStarted.make({}),
        say("also this"),
        ModelOutput.make({ items: [call("a", "send_user_message")], seenThroughSeq: 3 }),
        ToolResult.make({ callId: "a", tool: "send_user_message", output: "sent" })
      ])
    )

    expect(trace(history)).toEqual(["user: hi", "user: also this", "call: send_user_message", "result: a"])
  })

  it("holds a message that arrived during tool calls until their results", () => {
    const history = History.fromEntries(
      entries([
        say("check A-17"),
        ModelOutput.make({ items: [call("a", "lookup_order")], seenThroughSeq: 1 }),
        say("also 12 x 12?"),
        ToolResult.make({ callId: "a", tool: "lookup_order", output: "shipped" }),
        ModelOutput.make({ items: [call("b", "send_user_message")], seenThroughSeq: 4 })
      ])
    )

    expect(trace(history)).toEqual([
      "user: check A-17",
      "call: lookup_order",
      "result: a",
      "user: also 12 x 12?",
      "call: send_user_message"
    ])
  })
})

describe("History.fromEntries, after a crash", () => {
  it("leaves a call a turn left open without a result, for the loop to run again", () => {
    const history = History.fromEntries(
      entries([
        say("look up the orders"),
        TurnStarted.make({}),
        ModelOutput.make({ items: [call("a", "order_history")], seenThroughSeq: 2 }),
        ToolStarted.make({ callId: "a", tool: "order_history" }),
        // The process died here; the resumed turn starts, and a message arrives.
        TurnStarted.make({}),
        say("any news?")
      ])
    )

    // The message waits until the call has its result.
    expect(trace(history)).toEqual(["user: look up the orders", "call: order_history", "user: any news?"])
    expect(HistoryCheck.findUnansweredCalls(history).map((open) => open.call_id)).toEqual(["a"])
  })
})

describe("History.needsTurn", () => {
  it("is true while an input arrived after the last finished turn read", () => {
    const events = [say("hi"), TurnStarted.make({})]

    expect(History.needsTurn(entries(events))).toBe(true)
    expect(History.needsTurn(entries([...events, AssistantEvent.TurnCompleted.make({ throughSeq: 2 })]))).toBe(false)
    expect(
      History.unhandledInputs(
        entries([...events, AssistantEvent.TurnCompleted.make({ throughSeq: 2 }), say("more")])
      ).map((input) => input.id.length > 0)
    ).toEqual([true])
  })

  it("counts a failed turn as handled, so a failing input isn't retried", () => {
    expect(
      History.needsTurn(entries([say("boom"), AssistantEvent.TurnFailed.make({ throughSeq: 1, message: "x" })]))
    ).toBe(false)
  })
})

describe("History.fromEntries, a finished specialist run", () => {
  it("shows its status, how long it took, whether the user wrote since, and its report", () => {
    const runId = RunId.make()

    const history = History.fromEntries([
      AssistantEvent.Entry.make({ chatId, seq: 1, at: 0, event: say("research Q4") }),
      AssistantEvent.Entry.make({
        chatId,
        seq: 2,
        at: 1000,
        event: AssistantEvent.SpecialistStarted.make({ runId, specialist: "research", goal: "Q4 budgets" })
      }),
      AssistantEvent.Entry.make({
        chatId,
        seq: 3,
        at: 121_000,
        event: AssistantEvent.SpecialistFinished.make({
          id: InputId.make(`${runId}:1`),
          runId,
          specialist: "research",
          brief: 1,
          goal: "Q4 budgets",
          status: "answered",
          report: "Amsterdam spent most."
        })
      })
    ])

    expect(history.at(-1)).toMatchObject({
      content: [
        {
          text: `<specialist name="research" run="${runId}" status="answered">\nYou started it 2 minutes ago for: Q4 budgets\nThe user hasn't written since you started it.\nReport:\nAmsterdam spent most.\n</specialist>`
        }
      ]
    })
  })
})
