import { describe, expect, it } from "@effect/vitest"
import * as Response from "effect/ai/Response"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { AssistantEvent, ChatId } from "../../src/index.ts"
import * as Summary from "../../src/internal/summary.ts"
import { say } from "../utils/fixtures.ts"

const { ModelOutput, ToolResult, ToolStarted, TurnCompleted, TurnStarted } = AssistantEvent

const chatId = Effect.runSync(ChatId.make())

const entries = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, sequence: i + 1, at: DateTime.makeUnsafe(0), event }))

const call = (id: string, name: string, params: Record<string, string>) =>
  Response.makePart("tool-call", { id, name, params, providerExecuted: false })

const earlierTurn = [
  say("What did last summer's campaign cost?"),
  TurnStarted.make({ assistant: "test" }),
  ModelOutput.make({ parts: [call("a", "campaign_report", { campaignId: "summer" })], seenThroughSequence: 2 }),
  ToolStarted.make({ callId: "a", tool: "campaign_report" }),
  ToolResult.make({ callId: "a", tool: "campaign_report", outcome: "success", result: { spent: 1200 } }),
  TurnCompleted.make({ throughSequence: 5 })
]

describe("Summary.transcript", () => {
  it("gives this turn apart from the earlier messages it follows", () => {
    const transcript = Summary.transcript(
      entries([
        ...earlierTurn,
        say("And the winter one?"),
        TurnStarted.make({ assistant: "test" }),
        ModelOutput.make({ parts: [call("b", "campaign_report", { campaignId: "winter" })], seenThroughSequence: 8 }),
        ToolStarted.make({ callId: "b", tool: "campaign_report" })
      ]),
      []
    )

    expect(transcript).toBe(
      [
        "Earlier in the chat:",
        "User: What did last summer's campaign cost?",
        'Assistant runs campaign_report {"campaignId":"summer"}',
        'Result of campaign_report: {"spent":1200}',
        "",
        "This turn:",
        "User: And the winter one?",
        'Assistant runs campaign_report {"campaignId":"winter"}',
        "Running now: campaign_report"
      ].join("\n")
    )
  })

  it("names the lines the turn showed so far", () => {
    const transcript = Summary.transcript(
      entries([say("What did last summer's campaign cost?"), TurnStarted.make({ assistant: "test" })]),
      ["Checking the campaign", "Adding up the spend"]
    )

    expect(transcript).toBe(
      [
        "This turn:",
        "User: What did last summer's campaign cost?",
        "",
        'Shown so far: "Checking the campaign", "Adding up the spend"'
      ].join("\n")
    )
  })
})
