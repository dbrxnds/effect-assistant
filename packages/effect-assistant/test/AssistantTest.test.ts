/**
 * A chat driven like a user would: each step waits until a turn handled its input, and the chat
 * reads back what the assistant did, for the whole chat and for the step alone.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Assistant, AssistantTest, Block, BlockKit } from "../src/index.ts"
import { newChat, runMemory } from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const instructions = "You help a small team."

const SendReport = Tool.make("send_report", {
  description: "Emails the report. The user approves it first.",
  parameters: Schema.Struct({ to: Schema.String }),
  success: Schema.Struct({ sent: Schema.Boolean }),
  needsApproval: true
})

const FindReport = Tool.make("find_report", {
  description: "Finds the report.",
  success: Schema.Struct({ title: Schema.String })
})

const ReportTools = Toolkit.make(SendReport, FindReport)

const Pick = Block.make("pick", {
  description: "Lets the user pick one option.",
  props: Schema.Struct({ options: Schema.Array(Schema.String) }),
  answer: Schema.Struct({ choice: Schema.String })
})

const Reporting = Assistant.make("reporting", { blocks: BlockKit.make([Pick]) })

const script: Scripted.Script = (request) => {
  const last = Scripted.lastInput(request)

  if (last.includes("approved your call")) return Scripted.reply("Sent.")

  if (last.includes("rejected your call")) return Scripted.reply("Not sent.")

  if (last.includes("choice")) return Scripted.reply("The weekly one, then.")

  if (last.includes("Which report")) {
    return [
      Scripted.call("send_user_message", {
        text: "Which one?",
        wait: true,
        block: { kind: "pick", props: { options: ["weekly", "monthly"] } }
      })
    ]
  }

  if (Scripted.hasCalled(request, "find_report")) {
    return [
      Scripted.call("send_report", { to: "ana@example.com" }),
      Scripted.call("send_user_message", { text: "Sending the Q3 report to Ana once you approve.", wait: false })
    ]
  }

  return [Scripted.call("find_report")]
}

const layer = runMemory(
  Reporting.toLayer((turn) => turn.run({ instructions, toolkit: ReportTools })).pipe(
    Layer.provide(
      ReportTools.toLayer({
        send_report: () => Effect.succeed({ sent: true }),
        find_report: () => Effect.succeed({ title: "Q3" })
      })
    )
  ),
  Scripted.layer(script)
)

const start = Effect.gen(function* () {
  return AssistantTest.chat(yield* Reporting, yield* newChat)
})

describe("AssistantTest.chat", () => {
  it.live("reads what a step did: tools run, calls waiting for approval, messages", () =>
    Effect.gen(function* () {
      const asked = yield* (yield* start).say("Email the report to Ana")

      expect(asked.step.toolsRun).toEqual(["find_report"])
      expect(asked.step.waitingFor).toEqual(["send_report"])
      expect(asked.step.messages).toEqual(["Sending the Q3 report to Ana once you approve."])

      const sent = yield* asked.approve

      expect(sent.step.toolsRun).toEqual(["send_report"])
      expect(sent.step.messages).toEqual(["Sent."])
      expect(sent.toolsRun).toEqual(["find_report", "send_report"])
    }).pipe(Effect.provide(layer))
  )

  it.live("rejects the call waiting for approval", () =>
    Effect.gen(function* () {
      const asked = yield* (yield* start).say("Email the report to Ana")
      const rejected = yield* asked.reject()

      expect(rejected.toolsRun).not.toContain("send_report")
      expect(rejected.step.messages).toEqual(["Not sent."])
    }).pipe(Effect.provide(layer))
  )

  it.live("answers the block it showed", () =>
    Effect.gen(function* () {
      const asked = yield* (yield* start).say("Which report?")

      expect(asked.step.blocks).toEqual(["pick"])

      const answered = yield* asked.answer(Pick, { choice: "weekly" })

      expect(answered.step.messages).toEqual(["The weekly one, then."])
    }).pipe(Effect.provide(layer))
  )

  it.live("fails a step with nothing to approve", () =>
    Effect.gen(function* () {
      const error = yield* (yield* start).approve.pipe(Effect.flip)

      expect(error.reason).toBe("NothingToApprove")
    }).pipe(Effect.provide(layer))
  )
})
