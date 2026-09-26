import type * as Items from "@effect-uai/core/Items"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import { type Assistant, AssistantChat, AssistantEvent, BlockKit, ChatLog } from "../src/index.ts"
import { mayHaveRunOutput, notRunOutput } from "../src/internal/history.ts"
import { silentTurnMessage } from "../src/internal/turns.ts"
import { collectUntil, fact, memoryAssistant, newChat, say, TestAssistant, testModel, turnsDone } from "./fixtures.ts"
import * as Scripted from "./scripted.ts"

const toolCall = (callId: string, name: string): Items.ToolCall => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: "{}"
})

/** A handler that ends the turn with only `wait`, like a misbehaving model. */
const waitOnly = () =>
  Stream.make(
    AssistantEvent.ModelOutput.make({ items: [toolCall("wait-1", "wait")] }),
    AssistantEvent.ToolResult.make({ callId: "wait-1", tool: "wait", output: "waiting" })
  )

const layer = memoryAssistant(waitOnly, Scripted.unused)

/** A handler whose stream ends after a model output with a tool call, before the tool runs. */
const stopsEarly: Assistant.Handler = () =>
  Stream.make(AssistantEvent.ModelOutput.make({ items: [toolCall("lookup-1", "lookup")] }))

const stopsEarlyLayer = memoryAssistant(stopsEarly, Scripted.unused)

/**
 * The first turn reads the history, then a fact lands before it ends (like a
 * specialist's answer), and it waits without replying. The next turn replies.
 */
const lateFact = () => {
  let turns = 0

  return Effect.fn(function* (turn: Assistant.Turn) {
    turns += 1
    yield* turn.history()

    if (turns === 1) {
      yield* AssistantChat.AssistantChat.use((chat) =>
        chat.append([fact("specialist:research", { answer: "Ontario" })])
      )

      return Stream.make(
        AssistantEvent.ModelOutput.make({ items: [toolCall("w1", "wait")] }),
        AssistantEvent.ToolResult.make({ callId: "w1", tool: "wait", output: "waiting" })
      )
    }

    yield* AssistantChat.AssistantChat.use((chat) =>
      chat.append([AssistantEvent.AssistantMessage.make({ id: "answer", text: "It's in Ontario." })])
    )

    return Stream.empty
  })
}

const lastTurnEnd = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.flatMap(({ event }) => (AssistantEvent.isTurnEnd(event) ? [event] : [])).at(-1)

describe("turn completion", () => {
  it.live("records TurnFailed when client input gets no assistant message", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat
      yield* assistant.submit(chat, say("hello?"))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      const end = lastTurnEnd(entries)

      expect(end).toBeDefined()
      expect(Predicate.isTagged(end!, "TurnFailed")).toBe(true)
      expect(Predicate.isTagged(end!, "TurnFailed") ? end!.message : "").toBe(silentTurnMessage)
      expect(AssistantEvent.assistantTexts(entries)).toEqual([])
    }).pipe(Effect.provide(layer))
  )

  it.live("still allows a silent TurnCompleted for fact-only turns", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat
      yield* assistant.submit(
        chat,
        fact("workflow:InventorySync", { step: "3 of 10", status: "syncing", detail: "routine batch, nothing needed" })
      )
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      const end = lastTurnEnd(entries)

      expect(end).toBeDefined()
      expect(Predicate.isTagged(end!, "TurnCompleted")).toBe(true)
      expect(AssistantEvent.assistantTexts(entries)).toEqual([])
    }).pipe(Effect.provide(layer))
  )

  it.live("gives a call the handler never ran a result", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat
      yield* assistant.submit(chat, say("hello?"))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)
      const results = entries.flatMap(({ event }) => (Predicate.isTagged(event, "ToolResult") ? [event] : []))

      expect(results.map((result) => [result.callId, result.output])).toEqual([["lookup-1", notRunOutput]])
    }).pipe(Effect.provide(stopsEarlyLayer))
  )

  it.live("tells the model a call whose stream stopped while it ran may have done its work", () =>
    Effect.gen(function* () {
      // The call started, then the handler's stream ended before its result.
      const stopsMidCall = memoryAssistant(
        () =>
          Stream.make(
            AssistantEvent.ModelOutput.make({ items: [toolCall("send-1", "send")] }),
            AssistantEvent.ToolStarted.make({ callId: "send-1", tool: "send" })
          ),
        Scripted.unused
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* TestAssistant.submit(chat, say("send it"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(stopsMidCall))

      const results = entries.flatMap(({ event }) => (Predicate.isTagged(event, "ToolResult") ? [event] : []))

      expect(results.map((result) => [result.callId, result.output])).toEqual([["send-1", mayHaveRunOutput]])
    })
  )

  it.live("leaves an input that arrived after the loop's last read to the next turn, without failing this one", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat
      yield* assistant.submit(chat, say("which province is Ottawa in?"))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 2)

      expect(AssistantEvent.assistantTexts(entries)).toEqual(["It's in Ontario."])
      expect(entries.flatMap(({ event }) => (AssistantEvent.isTurnEnd(event) ? [event._tag] : []))).toEqual([
        "TurnCompleted",
        "TurnCompleted"
      ])
    }).pipe(Effect.provide(memoryAssistant(lateFact(), Scripted.unused)))
  )

  it.live("replyIfOwed runs one pass that can only reply, with the nudge", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(() => [
        Scripted.call("send_user_message", { text: "You're welcome.", wait: true })
      ])

      // The loop only calls wait, as a model might after answering a workflow's question.
      const handler = (turn: Assistant.Turn) =>
        waitOnly().pipe(
          Stream.concat(turn.replyIfOwed({ model: testModel, instructions: "Be brief.", nudge: "Reply now." }))
        )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* TestAssistant.submit(chat, say("Thanks, that's all I needed."))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(memoryAssistant(handler, model.layer)))

      const [request] = yield* model.requests

      expect(Predicate.isTagged(lastTurnEnd(entries)!, "TurnCompleted")).toBe(true)
      expect(AssistantEvent.assistantTexts(entries)).toEqual(["You're welcome."])
      expect(request?.tools).toEqual(["send_user_message"])
      expect(request?.toolChoice).toEqual({ type: "function", name: "send_user_message" })
      expect(request?.system.endsWith("Be brief.\n\nReply now.")).toBe(true)
    })
  )
})

describe("BlockKit.closeStale", () => {
  it.live("closes, from a turn, the blocks the user moved on from", () =>
    Effect.gen(function* () {
      const layer = memoryAssistant(
        Effect.fn(function* () {
          yield* BlockKit.closeStale({ messages: 2 })

          return Stream.empty
        }),
        Scripted.unused
      )

      const entries = yield* Effect.gen(function* () {
        const log = yield* ChatLog.ChatLog
        const chat = yield* newChat
        yield* log.append(chat, [
          AssistantEvent.AssistantMessage.make({
            id: "m1",
            text: "Red or blue?",
            block: AssistantEvent.MessageBlock.make({ kind: "choose_one", props: { options: ["red", "blue"] } })
          }),
          say("hmm")
        ])
        yield* TestAssistant.submit(chat, say("something else"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(layer))

      expect(
        entries.flatMap(({ event }) => (Predicate.isTagged(event, "BlocksClosed") ? event.messageIds : []))
      ).toEqual(["m1"])
      expect(BlockKit.blockStates(entries).get("m1")?.open).toBe(false)
    })
  )
})
