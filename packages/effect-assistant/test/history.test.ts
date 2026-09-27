import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import { AssistantEvent, ChatId, InputId, RunId } from "../src/index.ts"
import * as History from "../src/internal/history.ts"
import { say } from "./fixtures.ts"

const { ModelOutput, ToolResult, ToolStarted, TurnStarted } = AssistantEvent

const chatId = Effect.runSync(ChatId.make)

const entries = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: 0, event }))

const call = (id: string, name: string) =>
  Response.makePart("tool-call", { id, name, params: {}, providerExecuted: false })

const result = (callId: string, tool: string) => ToolResult.make({ callId, tool, outcome: "success", result: "sent" })

/** A readable trace: user text, tool calls by name, and tool results by call id. */
const trace = (history: ReadonlyArray<Prompt.Message>) =>
  history.flatMap((message) => {
    switch (message.role) {
      case "user":
        return [`user: ${message.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`]
      case "assistant":
        return message.content.flatMap((part) => (part.type === "tool-call" ? [`call: ${part.name}`] : []))
      case "tool":
        return message.content.flatMap((part) => (part.type === "tool-result" ? [`result: ${part.id}`] : []))
      case "system":
        return []
    }
  })

// These tests use the library's inputs only.
const noInputs: ReadonlySet<string> = new Set()

const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => History.fromEntries(entries, noInputs)

const needsTurn = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => History.needsTurn(entries, noInputs)

const unhandledInputs = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => History.unhandledInputs(entries, noInputs)

describe("History.fromEntries", () => {
  it("puts a message that arrived while the model was writing after that step", () => {
    // Seq 5 arrives after the step at seq 6 read through seq 4.
    const history = fromEntries(
      entries([
        say("what orders does amsterdam have"),
        TurnStarted.make({ assistant: "test" }),
        ModelOutput.make({ parts: [call("a", "order_history")], seenThroughSeq: 2 }),
        result("a", "order_history"),
        say("and do it for amsterdam"),
        ModelOutput.make({ parts: [call("b", "send_user_message")], seenThroughSeq: 4 }),
        result("b", "send_user_message")
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
    const history = fromEntries(
      entries([
        say("hi"),
        TurnStarted.make({ assistant: "test" }),
        say("also this"),
        ModelOutput.make({ parts: [call("a", "send_user_message")], seenThroughSeq: 3 }),
        result("a", "send_user_message")
      ])
    )

    expect(trace(history)).toEqual(["user: hi", "user: also this", "call: send_user_message", "result: a"])
  })

  it("holds a message that arrived during tool calls until their results", () => {
    const history = fromEntries(
      entries([
        say("check A-17"),
        ModelOutput.make({ parts: [call("a", "lookup_order")], seenThroughSeq: 1 }),
        say("also 12 x 12?"),
        result("a", "lookup_order"),
        ModelOutput.make({ parts: [call("b", "send_user_message")], seenThroughSeq: 4 })
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
    const history = fromEntries(
      entries([
        say("look up the orders"),
        TurnStarted.make({ assistant: "test" }),
        ModelOutput.make({ parts: [call("a", "order_history")], seenThroughSeq: 2 }),
        ToolStarted.make({ callId: "a", tool: "order_history" }),
        // The process died here; the resumed turn starts, and a message arrives.
        TurnStarted.make({ assistant: "test" }),
        say("any news?")
      ])
    )

    // The message waits until the call has its result.
    expect(trace(history)).toEqual(["user: look up the orders", "call: order_history", "user: any news?"])
    expect(History.unansweredCalls(history).map((open) => open.id)).toEqual(["a"])
  })
})

describe("History.needsTurn", () => {
  it("is true while an input arrived after the last finished turn read", () => {
    const events = [say("hi"), TurnStarted.make({ assistant: "test" })]

    expect(needsTurn(entries(events))).toBe(true)
    expect(needsTurn(entries([...events, AssistantEvent.TurnCompleted.make({ throughSeq: 2 })]))).toBe(false)
    expect(
      unhandledInputs(entries([...events, AssistantEvent.TurnCompleted.make({ throughSeq: 2 }), say("more")])).map(
        (input) => input._tag
      )
    ).toEqual(["UserMessage"])
  })

  it("counts a failed turn as handled, so a failing input isn't retried", () => {
    expect(needsTurn(entries([say("boom"), AssistantEvent.TurnFailed.make({ throughSeq: 1, message: "x" })]))).toBe(
      false
    )
  })
})

describe("History.fromEntries, a finished specialist run", () => {
  it("shows its status, how long it took, whether the user wrote since, and its report", () => {
    const runId = RunId.fromKey("history-test")

    const history = fromEntries([
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
          id: InputId.fromKey(`${runId}:1`),
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
          text: `<specialist name="research" run="${runId}" status="answered">\nA report from a specialist you started. The user hasn't seen it.\nYou started it 2 minutes ago for: Q4 budgets\nThe user hasn't written since you started it.\nReport:\nAmsterdam spent most.\n</specialist>`
        }
      ]
    })
  })
})

describe("stored forms", () => {
  it("reads a model step and a tool result at format 2, and not the forms before it", () => {
    const decode = Schema.decodeUnknownOption(AssistantEvent.AssistantEvent)
    const step = Schema.encodeSync(ModelOutput)(ModelOutput.make({ parts: [call("a", "t")] }))
    const stored = Schema.encodeSync(ToolResult)(result("a", "t"))
    const { format: _step, parts: _parts, ...stepBefore } = step
    const { format: _result, outcome: _outcome, result: _value, ...resultBefore } = stored

    expect(Option.isSome(decode(step))).toBe(true)
    expect(Option.isNone(decode({ ...stepBefore, items: [] }))).toBe(true)
    expect(Option.isSome(decode(stored))).toBe(true)
    expect(Option.isNone(decode({ ...resultBefore, output: "sent" }))).toBe(true)
  })
})
