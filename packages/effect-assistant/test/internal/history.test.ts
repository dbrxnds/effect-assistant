import { describe, expect, it } from "@effect/vitest"
import type * as Prompt from "effect/ai/Prompt"
import * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import { AssistantEvent, ChatId, Decision, DecisionId, InputId, RunId } from "../../src/index.ts"
import * as Decisions from "../../src/internal/decisions.ts"
import * as History from "../../src/internal/history.ts"
import { say } from "../utils/fixtures.ts"

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
const noWakes: ReadonlySet<string> = new Set()

const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => History.fromEntries(entries, () => undefined)

const needsTurn = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => History.needsTurn(entries, noWakes)

const unhandledInputs = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => History.unhandledInputs(entries, noWakes)

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
        event: AssistantEvent.SpecialistStarted.make({
          runId,
          specialist: "research",
          goal: "Q4 budgets"
        })
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

describe("History.fromEntries, decisions", () => {
  const params = { sku: "tote", quantity: 300 }
  const id = DecisionId.fromCallId("a")

  const parked = [
    say("order 300 totes"),
    TurnStarted.make({ assistant: "test" }),
    ModelOutput.make({
      parts: [
        Response.makePart("tool-call", {
          id: "a",
          name: "place_order",
          params,
          providerExecuted: false
        })
      ],
      seenThroughSeq: 2
    }),
    AssistantEvent.DecisionRequested.make({
      id,
      origin: AssistantEvent.CallOrigin.make({ callId: "a", tool: "place_order", params }),
      preview: { total: 600 }
    }),
    ModelOutput.make({ parts: [call("b", "send_user_message")], seenThroughSeq: 4 }),
    result("b", "send_user_message"),
    AssistantEvent.AssistantMessage.make({
      id: "m",
      text: "Place it?",
      block: AssistantEvent.MessageBlock.make({
        kind: Decision.kind,
        props: { decisionIds: [id] }
      })
    }),
    AssistantEvent.TurnCompleted.make({ throughSeq: 7 })
  ]

  const answer = (outcome: AssistantEvent.DecisionOutcome) =>
    AssistantEvent.BlockAnswer.make({
      id: InputId.fromKey("m:answer"),
      messageId: "m",
      kind: Decision.kind,
      value: { decisions: { [id]: outcome } }
    })

  const resolved = (outcome: AssistantEvent.DecisionOutcome) =>
    AssistantEvent.DecisionResolved.make({ id, outcome, answer: InputId.fromKey("m:answer") })

  const texts = (history: ReadonlyArray<Prompt.Message>) =>
    history.flatMap((message) =>
      message.role === "user" ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : []
    )

  it("answers a parked call with its decision: waiting, with the decision's id and the preview", () => {
    const history = fromEntries(entries(parked))

    const [first] = history.flatMap((message) =>
      message.role === "tool" ? message.content.flatMap((part) => (part.type === "tool-result" ? [part] : [])) : []
    )

    expect(trace(history)).toEqual([
      "user: order 300 totes",
      "call: place_order",
      "result: a",
      "call: send_user_message",
      "result: b"
    ])
    expect(first?.isFailure).toBe(false)
    expect(first?.result).toMatchObject({
      status: "waiting_for_decision",
      decisionId: id,
      preview: { total: 600 }
    })
    // Parked is answered: the loop doesn't run it again.
    expect(History.unansweredCalls(history)).toEqual([])
    expect(Decisions.approvedCalls(entries(parked))).toEqual([])
  })

  it("reads an approval, then the call's result where it ran, as the decision's", () => {
    const approved = [...parked, answer("approved"), resolved("approved")]

    // Approved and not run yet: the loop runs it, as the model made it.
    expect(Decisions.approvedCalls(entries(approved)).map((pending) => [pending.id, pending.params])).toEqual([
      ["a", params]
    ])

    const ran = [
      ...approved,
      TurnStarted.make({ assistant: "test" }),
      ToolStarted.make({ callId: "a", tool: "place_order" }),
      ToolResult.make({
        callId: "a",
        tool: "place_order",
        outcome: "success",
        result: { reference: "R-1" }
      })
    ]

    const history = fromEntries(entries(ran))

    expect(texts(history).slice(-2)).toEqual([
      `<answer message="m" kind="decision">\nThe user decided with the block on your message m:\n- ${id}: approved: place_order runs now, and its result follows.\n</answer>`,
      `<decision id="${id}" tool="place_order" outcome="approved">\nThe user approved it, and place_order ran: success.\n{"reference":"R-1"}\n</decision>`
    ])
    // One result per call: the run's reads as a message, not a second tool result.
    expect(trace(history).filter((line) => line === "result: a")).toHaveLength(1)
    expect(History.unansweredCalls(history)).toEqual([])
    expect(Decisions.approvedCalls(entries(ran))).toEqual([])
  })

  it("reads an approved call's result as text when a view starts after the call", () => {
    const later = [
      answer("approved"),
      resolved("approved"),
      TurnStarted.make({ assistant: "test" }),
      ToolStarted.make({ callId: "a", tool: "place_order" }),
      ToolResult.make({
        callId: "a",
        tool: "place_order",
        outcome: "success",
        result: { reference: "R-1" }
      })
    ]

    // Only what came after the parked call and its request, like a view since a summary.
    const history = fromEntries(entries([...parked, ...later]).slice(parked.length))

    expect(history.every((message) => message.role === "user")).toBe(true)
    expect(texts(history).at(-1)).toContain('<result tool="place_order" call="a" outcome="success">')
  })

  it("reads a decline as a call that didn't run", () => {
    const declined = [...parked, answer("declined"), resolved("declined")]
    const history = fromEntries(entries(declined))

    expect(texts(history).at(-1)).toContain(`- ${id}: declined: place_order didn't run, and won't.`)
    expect(Decisions.approvedCalls(entries(declined))).toEqual([])
  })

  it("reads a decision that work asks for as an input, with its preview", () => {
    const request = AssistantEvent.DecisionRequested.make({
      id: DecisionId.fromKey("launch"),
      origin: AssistantEvent.WorkOrigin.make({ source: "workflow:Launch" }),
      preview: { budget: 2000 }
    })

    const log = entries([say("hi"), AssistantEvent.TurnCompleted.make({ throughSeq: 1 }), request])

    expect(needsTurn(log)).toBe(true)
    expect(texts(fromEntries(log)).at(-1)).toBe(
      `<decision id="${request.id}" source="workflow:Launch" status="requested">\nWork that's running needs the user's decision. The user hasn't seen it: send them a message with a decision block for this id that says what they decide on.\n{"budget":2000}\n</decision>`
    )
  })
})
