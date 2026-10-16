import { describe, expect, it } from "@effect/vitest"
import * as Prompt from "effect/ai/Prompt"
import * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import { AssistantEvent, ChatId, InputId, RunId } from "../../src/index.ts"
import * as History from "../../src/internal/history.ts"
import * as Uuid from "../../src/internal/uuid.ts"
import { say, storedUpdate, submittedUpdate } from "../utils/fixtures.ts"

const { ModelOutput, ToolResult, ToolStarted, TurnStarted } = AssistantEvent

const chatId = Effect.runSync(ChatId.make())

const entries = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, sequence: i + 1, at: 0, event }))

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

const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry | Prompt.Message>) => History.fromEntries(entries)

const needsTurn = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => History.needsTurn(entries)

const unhandledInputs = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => History.unhandledInputs(entries)

describe("History.fromEntries", () => {
  it("puts a message that arrived while the model was writing after that step", () => {
    // Sequence 5 arrives after the step at sequence 6 read through sequence 4.
    const history = fromEntries(
      entries([
        say("what orders does amsterdam have"),
        TurnStarted.make({ assistant: "test" }),
        ModelOutput.make({ parts: [call("a", "order_history")], seenThroughSequence: 2 }),
        result("a", "order_history"),
        say("and do it for amsterdam"),
        ModelOutput.make({ parts: [call("b", "send_user_message")], seenThroughSequence: 4 }),
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
        ModelOutput.make({ parts: [call("a", "send_user_message")], seenThroughSequence: 3 }),
        result("a", "send_user_message")
      ])
    )

    expect(trace(history)).toEqual(["user: hi", "user: also this", "call: send_user_message", "result: a"])
  })

  it("holds a message that arrived during tool calls until their results", () => {
    const history = fromEntries(
      entries([
        say("check A-17"),
        ModelOutput.make({ parts: [call("a", "lookup_order")], seenThroughSequence: 1 }),
        say("also 12 x 12?"),
        result("a", "lookup_order"),
        ModelOutput.make({ parts: [call("b", "send_user_message")], seenThroughSequence: 4 })
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
        ModelOutput.make({ parts: [call("a", "order_history")], seenThroughSequence: 2 }),
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
    expect(needsTurn(entries([...events, AssistantEvent.TurnCompleted.make({ throughSequence: 2 })]))).toBe(false)
    expect(
      unhandledInputs(entries([...events, AssistantEvent.TurnCompleted.make({ throughSequence: 2 }), say("more")])).map(
        (input) => input._tag
      )
    ).toEqual(["UserMessage"])
  })

  it("counts a failed turn as handled, so a failing input isn't retried", () => {
    expect(
      needsTurn(entries([say("boom"), AssistantEvent.TurnFailed.make({ throughSequence: 1, message: "x" })]))
    ).toBe(false)
  })
})

describe("History.fromEntries, a finished specialist run", () => {
  it("shows its status, how long it took, whether the user wrote since, and its report", () => {
    const runId = RunId.fromKey("history-test")

    const history = fromEntries([
      AssistantEvent.Entry.make({ chatId, sequence: 1, at: 0, event: say("research Q4") }),
      AssistantEvent.Entry.make({
        chatId,
        sequence: 2,
        at: 1000,
        event: AssistantEvent.SpecialistStarted.make({
          runId,
          specialist: "research",
          goal: "Q4 budgets"
        })
      }),
      AssistantEvent.Entry.make({
        chatId,
        sequence: 3,
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

describe("History.fromEntries, block answers and earlier results", () => {
  const texts = (history: ReadonlyArray<Prompt.Message>) =>
    history.flatMap((message) =>
      message.role === "user" ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : []
    )

  it("reads a block answer as the user's answer on that message", () => {
    const history = fromEntries(
      entries([
        say("order 300 totes"),
        AssistantEvent.AssistantMessage.make({
          id: "m",
          text: "Which color?",
          block: AssistantEvent.MessageBlock.make({ kind: "choose_one", props: { options: ["red", "blue"] } })
        }),
        AssistantEvent.BlockAnswer.make({
          id: InputId.fromKey("m:answer"),
          messageId: "m",
          kind: "choose_one",
          value: { choice: "blue" }
        })
      ])
    )

    expect(texts(history).at(-1)).toEqual(
      '<answer message="m" kind="choose_one">\nThe user answered with the block on your message m.\n{"choice":"blue"}\n</answer>'
    )
  })

  it("reads a call's result as text when a view starts after the call", () => {
    const events = [
      say("look up the orders"),
      ModelOutput.make({ parts: [call("a", "order_history")], seenThroughSequence: 1 }),
      ToolStarted.make({ callId: "a", tool: "order_history" }),
      ToolResult.make({ callId: "a", tool: "order_history", outcome: "success", result: { orders: 3 } })
    ]

    // Only what came after the call, like a view since a summary.
    const history = fromEntries(entries(events).slice(2))

    expect(history.every((message) => message.role === "user")).toBe(true)
    expect(texts(history).at(-1)).toContain('<result tool="order_history" call="a" outcome="success">')
  })
})

describe("History.fromEntries, the app's own events", () => {
  const note = (text: string) => Prompt.userMessage({ content: [Prompt.textPart({ text })] })

  it("reads none of them by itself", () => {
    const history = fromEntries([
      ...entries([say("hi")]),
      AssistantEvent.Entry.make({
        chatId,
        sequence: 2,
        at: 0,
        event: storedUpdate("workflow:Order", { status: "done" })
      })
    ])

    expect(trace(history)).toEqual(["user: hi"])
  })

  it("keeps a call and its result together around a message a view put between them", () => {
    const [ask, output, started, done] = entries([
      say("look up the orders"),
      ModelOutput.make({ parts: [call("a", "order_history")], seenThroughSequence: 1 }),
      ToolStarted.make({ callId: "a", tool: "order_history" }),
      result("a", "order_history")
    ])

    const history = fromEntries([ask!, output!, started!, note("The order shipped."), done!])

    expect(trace(history)).toEqual([
      "user: look up the orders",
      "call: order_history",
      "result: a",
      "user: The order shipped."
    ])
    expect(History.unansweredCalls(history)).toEqual([])
  })

  it("puts a message after the step whose model call didn't read it", () => {
    // The note stands for an event at sequence 2; the step at sequence 3 read through sequence 1.
    const [ask, output] = entries([say("hi"), ModelOutput.make({ parts: [call("w", "wait")], seenThroughSequence: 1 })])

    const history = fromEntries([ask!, note("The order shipped."), { ...output!, sequence: 3 }])

    expect(trace(history)).toEqual(["user: hi", "call: wait", "user: The order shipped."])
  })
})

describe("History.needsTurn, the app's own events", () => {
  it("counts one that came in through submit as an input, and not one a turn appended", () => {
    const after = (event: AssistantEvent.StoredAppEvent) => [
      ...entries([
        say("hi"),
        TurnStarted.make({ assistant: "test" }),
        AssistantEvent.TurnCompleted.make({ throughSequence: 2 })
      ]),
      AssistantEvent.Entry.make({ chatId, sequence: 4, at: 0, event })
    ]

    expect(needsTurn(after(submittedUpdate("workflow:Order", { status: "done" })))).toBe(true)
    expect(needsTurn(after(storedUpdate("workflow:Order", { status: "done" })))).toBe(false)
  })
})

describe("History.owesDelivery", () => {
  const send = (id: string, wait: boolean) =>
    ModelOutput.make({
      parts: [
        Response.makePart("tool-call", {
          id,
          name: "send_user_message",
          params: { text: id, wait },
          providerExecuted: false
        })
      ],
      seenThroughSequence: 1
    })

  const message = (callId: string) =>
    AssistantEvent.AssistantMessage.make({ id: Uuid.fromKey(`message:${callId}`), text: callId })

  const withBlock = (callId: string) =>
    AssistantEvent.AssistantMessage.make({
      id: Uuid.fromKey(`message:${callId}`),
      text: callId,
      block: AssistantEvent.MessageBlock.make({ kind: "tool_result", props: {} })
    })

  it("is owed when the last message since the input was progress, after a result for something earlier", () => {
    const log = entries([
      say("The dirty ones, and the maple ones?"),
      send("result", false),
      withBlock("result"),
      send("progress", false),
      message("progress")
    ])

    expect(History.owesDelivery(log, 1)).toBe(true)
  })

  it("isn't owed when the last message delivered", () => {
    const log = entries([
      say("The dirty ones, and the maple ones?"),
      send("progress", false),
      message("progress"),
      send("result", false),
      withBlock("result")
    ])

    expect(History.owesDelivery(log, 1)).toBe(false)
  })

  const sendWorking = (id: string, wait: boolean) =>
    ModelOutput.make({
      parts: [
        Response.makePart("tool-call", {
          id,
          name: "send_user_message",
          params: { text: id, wait },
          providerExecuted: false
        }),
        Response.makePart("tool-call", { id: `${id}-search`, name: "search", params: {}, providerExecuted: false })
      ],
      seenThroughSequence: 1
    })

  it("is owed when a message with wait true went out in the same step as other calls", () => {
    const log = entries([
      say("The dirty ones, and the maple ones?"),
      sendWorking("progress", true),
      message("progress"),
      result("progress-search", "search")
    ])

    expect(History.owesDelivery(log, 1)).toBe(true)
  })

  it("isn't owed when a message with wait true went out alone", () => {
    const log = entries([say("The dirty ones, and the maple ones?"), send("answer", true), message("answer")])

    expect(History.owesDelivery(log, 1)).toBe(false)
  })
})
