import { describe, expect, it } from "@effect/vitest"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Assistant, AssistantEvent, ChatId, Compaction, CurrentChat, RunId, ToolApproval } from "../src/index.ts"
import { collectUntil, newChat, runMemory, say, turnsDone } from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  text: Schema.String,
  throughSeq: Schema.Int
}) {}

const Compacting = Assistant.make("compaction-test", { events: [Summary] })

const history = Compaction.since(Schema.is(Summary))

const summarizePrompt = "Summarize this chat so far. Answer in text, without calling a tool."

/** A handler that summarizes after every turn without a summary yet, like one past its threshold. */
const compacting = (turn: Assistant.Turn<Summary>) => {
  const options = { instructions: "Be brief.", history }

  const compact = Effect.gen(function* () {
    const entries = yield* (yield* CurrentChat.CurrentChat).entries

    if (entries.some(({ event }) => event instanceof Summary)) return

    const { text } = yield* LanguageModel.generateText({ prompt: summarizePrompt })
    yield* (yield* CurrentChat.CurrentChat).append(Summary.make({ text, throughSeq: entries.at(-1)?.seq ?? 0 }))
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
        yield* (yield* Compacting).submit(chat, say("I want 300 totes, in blue."))
        yield* collectUntil(Compacting, chat, (es) => turnsDone(es) >= 1)
        yield* (yield* Compacting).submit(chat, say("Make them red."))

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

  it("keeps what is still open after the summary: a block the user hasn't answered, and a specialist working", () => {
    const chatId = Effect.runSync(ChatId.make())
    const runId = RunId.fromKey("compaction-test")

    const events = [
      say("Order 300 totes."),
      AssistantEvent.AssistantMessage.make({
        id: "m1",
        text: "Which color?",
        block: AssistantEvent.MessageBlock.make({ kind: "choose_one", props: { options: ["red", "blue"] } })
      }),
      AssistantEvent.SpecialistStarted.make({ runId, specialist: "research", goal: "Compare tote suppliers" })
    ]

    const entries = events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: 0, event }))

    expect(Compaction.openItems(entries, entries.length)).toEqual(
      Option.some(
        `Blocks the user hasn't answered:\n- message m1, a choose_one block: Which color?\n\nSpecialists still working:\n- your research specialist (${runId}), working on: Compare tote suppliers`
      )
    )
    // Opened after the summary: the entries after it show it themselves.
    expect(Compaction.openItems(entries, 1)).toEqual(Option.none())
  })

  it("keeps the app's other events after the summary as entries, for a view to map", () => {
    const chatId = Effect.runSync(ChatId.make())

    class Shipped extends Schema.TaggedClass<Shipped>()("Shipped", { orderId: Schema.String }) {}

    const entries: ReadonlyArray<Assistant.Entry<Summary | Shipped>> = [
      { chatId, seq: 1, at: 0, event: say("Order 300 totes.") },
      { chatId, seq: 2, at: 0, event: Summary.make({ text: "They ordered totes.", throughSeq: 1 }) },
      { chatId, seq: 3, at: 0, event: Shipped.make({ orderId: "o1" }) }
    ]

    const viewed = history(entries)

    expect(viewed).toHaveLength(2)
    expect(viewed[1]).toEqual(entries[2])
  })

  it("keeps a call that still waits for the user's approval among what's open", () => {
    const chatId = Effect.runSync(ChatId.make())

    const events = [
      say("Order 300 totes."),
      AssistantEvent.ApprovalRequested.make({ callId: "c1", tool: "place_order", params: { quantity: 300 } }),
      AssistantEvent.ApprovalRequested.make({ callId: "c2", tool: "place_order", params: { quantity: 5 } }),
      ToolApproval.reject({ id: "c2" })
    ]

    const entries = events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: 0, event }))

    expect(Compaction.openItems(entries, entries.length)).toEqual(
      Option.some(`Calls waiting for the user's approval:\n- your call to place_order (c1): {"quantity":300}`)
    )
  })
})
