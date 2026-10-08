import { describe, expect, it } from "@effect/vitest"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { AppEvent, Assistant, AssistantEvent, ChatId, Compaction, DecisionId } from "../src/index.ts"
import { collectUntil, newChat, runMemory, say, turnsDone } from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  text: Schema.String,
  throughSeq: Schema.Int
}) {}

const Compacting = Assistant.make("compaction-test", { events: [AppEvent.make(Summary)] })

const history = Compaction.since(Schema.is(Summary))

const summarizePrompt = "Summarize this chat so far. Answer in text, without calling a tool."

/** A handler that summarizes after every turn without a summary yet, like one past its threshold. */
const compacting = (turn: Assistant.Turn<Summary>) => {
  const options = { instructions: "Be brief.", history }

  const compact = Effect.gen(function* () {
    const entries = yield* turn.entries

    if (entries.some(({ event }) => event instanceof Summary)) return

    const { text } = yield* LanguageModel.generateText({ prompt: summarizePrompt })
    yield* turn.append(Summary.make({ text, throughSeq: entries.at(-1)?.seq ?? 0 }))
  })

  return Stream.concat(turn.loop(options), Stream.drain(Stream.fromEffect(compact)))
}

describe("Compaction", () => {
  it.live("reads the summary instead of what it covers", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make((request) => {
        const last = Scripted.lastInput(request)

        if (last === summarizePrompt) return [Scripted.text("They want 300 totes, in blue.")]

        if (last.includes("red")) return Scripted.reply("Red it is.")

        return Scripted.reply("Blue totes, noted.")
      })

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* Compacting.submit(chat, say("I want 300 totes, in blue."))
        yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 1)
        yield* Compacting.submit(chat, say("Make them red."))

        return yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 2)
      }).pipe(Effect.provide(runMemory(Compacting.toLayer(compacting), model.layer)))

      const [, , second] = yield* model.requests

      // The next turn reads the summary, not the messages it covers.
      expect(Scripted.inputs(second!)).toEqual([
        "<earlier_in_this_chat>\nThey want 300 totes, in blue.\n</earlier_in_this_chat>",
        "Make them red."
      ])
      expect(AssistantEvent.assistantTexts(entries)).toEqual(["Blue totes, noted.", "Red it is."])
    })
  )

  it("keeps what is still open after the summary: a decision waiting for the user", () => {
    const chatId = Effect.runSync(ChatId.make)
    const callId = "toolu_order_1"
    const decisionId = DecisionId.fromCallId(callId)

    const events = [
      say("Order 300 totes."),
      AssistantEvent.ModelOutput.make({
        parts: [
          Response.makePart("tool-call", {
            id: callId,
            name: "place_order",
            params: { quantity: 300 },
            providerExecuted: false
          })
        ]
      }),
      AssistantEvent.DecisionRequested.make({
        id: decisionId,
        origin: AssistantEvent.CallOrigin.make({
          callId,
          tool: "place_order",
          params: { quantity: 300 }
        }),
        preview: { total: 600 }
      })
    ]

    const entries = events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: 0, event }))

    expect(Compaction.openItems(entries, entries.length)).toEqual(
      Option.some(`Decisions waiting for the user:\n- decision ${decisionId}, for place_order: {"total":600}`)
    )
    // Opened after the summary: the entries after it show it themselves.
    expect(Compaction.openItems(entries, 1)).toEqual(Option.none())
  })
})
