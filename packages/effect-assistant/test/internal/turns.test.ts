import { describe, expect, it } from "@effect/vitest"
import * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import * as Tracer from "effect/Tracer"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Deferred from "effect/Deferred"
import * as Schema from "effect/Schema"
import {
  type Assistant,
  AssistantActivity,
  AssistantEngine,
  AssistantEvent,
  BlockKit,
  ChatLog,
  CurrentChat
} from "../../src/index.ts"
import { mayHaveRunOutput, notRunOutput } from "../../src/internal/history.ts"
import { deliveryNudge, silentTurnMessage } from "../../src/internal/turns.ts"
import * as Uuid from "../../src/internal/uuid.ts"
import {
  collectUntil,
  layerStorage,
  memoryAssistant,
  newChat,
  runMemory,
  say,
  simple,
  TestAssistant,
  turnsDone,
  update,
  type Update,
  Updating,
  updatingAssistant
} from "../utils/fixtures.ts"
import * as Scripted from "../utils/scripted.ts"

const toolCall = (callId: string, name: string) =>
  Response.makePart("tool-call", { id: callId, name, params: {}, providerExecuted: false })

/** A handler that ends the turn with only `wait`, like a misbehaving model. */
const waitOnly = () =>
  Stream.make(
    AssistantEvent.ModelOutput.make({ parts: [toolCall("wait-1", "wait")] }),
    AssistantEvent.ToolResult.make({
      callId: "wait-1",
      tool: "wait",
      outcome: "success",
      result: "waiting"
    })
  )

const layer = memoryAssistant(waitOnly, Scripted.unused)

const updatingLayer = updatingAssistant(waitOnly, Scripted.unused)

/** A handler whose stream ends after a model output with a tool call, before the tool runs. */
const stopsEarly: Assistant.Handler = () =>
  Stream.make(AssistantEvent.ModelOutput.make({ parts: [toolCall("lookup-1", "lookup")] }))

const stopsEarlyLayer = memoryAssistant(stopsEarly, Scripted.unused)

const lastTurnEnd = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.flatMap(({ event }) => (AssistantEvent.isTurnEnd(event) ? [event] : [])).at(-1)

describe("turn completion", () => {
  it.live("records TurnFailed when the loop ends without a message for the user's input", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat
      yield* (yield* assistant).submit(chat, say("hello?"))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      const end = lastTurnEnd(entries)

      expect(end).toBeDefined()
      expect(Predicate.isTagged(end!, "TurnFailed")).toBe(true)
      expect(Predicate.isTagged(end!, "TurnFailed") ? end!.message : "").toBe(silentTurnMessage)
      expect(AssistantEvent.assistantTexts(entries)).toEqual([])
    }).pipe(
      Effect.provide(
        memoryAssistant(
          simple({ instructions: "Be brief." }),
          Scripted.layer(() => Scripted.wait())
        )
      )
    )
  )

  it.live("never fails a handler that ends without the loop for being silent", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat
      yield* (yield* assistant).submit(chat, say("hello?"))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      expect(Predicate.isTagged(lastTurnEnd(entries)!, "TurnCompleted")).toBe(true)
      expect(AssistantEvent.assistantTexts(entries)).toEqual([])
    }).pipe(Effect.provide(layer))
  )

  it.live("ends a turn whose handler records an app event and returns without the loop, waking none", () =>
    Effect.gen(function* () {
      const handler = Effect.fn(function* () {
        yield* (yield* CurrentChat.CurrentChat).append(update("budget", { reached: "today" }))

        return Stream.empty
      })

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Updating).submit(chat, say("one more?"))

        return yield* collectUntil(Updating, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(updatingAssistant(handler, Scripted.unused)))

      expect(entries.map(({ event }) => event._tag)).toEqual(["UserMessage", "TurnStarted", "Update", "TurnCompleted"])
      expect(AssistantActivity.isWorking(AssistantActivity.fromEntries(entries))).toBe(false)
    })
  )

  it.live("still allows a silent TurnCompleted for turns woken only by an app event", () =>
    Effect.gen(function* () {
      const assistant = Updating
      const chat = yield* newChat
      yield* (yield* assistant).submit(
        chat,
        update("workflow:InventorySync", {
          step: "3 of 10",
          status: "syncing",
          detail: "routine batch, nothing needed"
        })
      )
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)

      const end = lastTurnEnd(entries)

      expect(end).toBeDefined()
      expect(Predicate.isTagged(end!, "TurnCompleted")).toBe(true)
      expect(AssistantEvent.assistantTexts(entries)).toEqual([])
    }).pipe(Effect.provide(updatingLayer))
  )

  it.live("gives a call the handler never ran a result", () =>
    Effect.gen(function* () {
      const assistant = TestAssistant
      const chat = yield* newChat
      yield* (yield* assistant).submit(chat, say("hello?"))
      const entries = yield* collectUntil(assistant, chat, (es) => turnsDone(es) >= 1)
      const results = entries.flatMap(({ event }) => (Predicate.isTagged(event, "ToolResult") ? [event] : []))

      expect(results.map((result) => [result.callId, result.result])).toEqual([["lookup-1", notRunOutput]])
    }).pipe(Effect.provide(stopsEarlyLayer))
  )

  it.live("sends a message once when a crash cut off its call after the message was stored", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* newChat
      const callId = "toolu_send_1"

      yield* log.append(chat, [
        say("hi"),
        AssistantEvent.TurnStarted.make({ assistant: TestAssistant.name }),
        AssistantEvent.ModelOutput.make({
          parts: [
            Response.makePart("tool-call", {
              id: callId,
              name: "send_user_message",
              params: { text: "Hello!", wait: true },
              providerExecuted: false
            })
          ],
          seenThroughSequence: 1
        }),
        AssistantEvent.ToolStarted.make({ callId, tool: "send_user_message" }),
        AssistantEvent.AssistantMessage.make({
          id: Uuid.fromKey(`message:${callId}`),
          text: "Hello!"
        })
      ])

      // The restart: the engine resumes the chat, and the cut-off call runs again.
      const restarted = TestAssistant.toLayer(simple({ instructions: "Be brief." })).pipe(
        Layer.provideMerge(AssistantEngine.layerMemory),
        Layer.provide(Scripted.unused)
      )

      const entries = yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1).pipe(
        Effect.provide(restarted)
      )

      expect(AssistantEvent.assistantTexts(entries)).toEqual(["Hello!"])
    }).pipe(Effect.provide(layerStorage))
  )

  it.live("tells the model a call whose stream stopped while it ran may have done its work", () =>
    Effect.gen(function* () {
      // The call started, then the handler's stream ended before its result.
      const stopsMidCall = memoryAssistant(
        () =>
          Stream.make(
            AssistantEvent.ModelOutput.make({ parts: [toolCall("send-1", "send")] }),
            AssistantEvent.ToolStarted.make({ callId: "send-1", tool: "send" })
          ),
        Scripted.unused
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("send it"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(stopsMidCall))

      const results = entries.flatMap(({ event }) => (Predicate.isTagged(event, "ToolResult") ? [event] : []))

      expect(results.map((result) => [result.callId, result.result])).toEqual([["send-1", mayHaveRunOutput]])
    })
  )

  it.live("leaves an input that arrived after the loop's last read to the next turn, without failing this one", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const submitted = yield* Deferred.make<void>()

      // A call that runs until the test has submitted an update: it lands after the model's last read.
      const Hold = Tool.make("hold", { description: "Holds.", success: Schema.String })

      const HoldTools = Toolkit.make(Hold)

      const handler = (turn: Assistant.Turn<Update>) =>
        Stream.unwrap(
          Effect.map(
            HoldTools.toHandlers({
              hold: () =>
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(submitted)), Effect.as("held"))
            }),
            (handlers) =>
              turn.run({ instructions: "Be brief.", toolkit: HoldTools }).pipe(Stream.provideContext(handlers))
          )
        )

      let step = 0

      const model = Scripted.layer(() =>
        ++step === 1 ? [Scripted.call("wait"), Scripted.call("hold")] : Scripted.reply("It's in Ontario.")
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Updating).submit(chat, say("which province is Ottawa in?"))
        yield* Deferred.await(started)
        yield* (yield* Updating).submit(chat, update("specialist:research", { answer: "Ontario" }))
        yield* Deferred.succeed(submitted, undefined)

        return yield* collectUntil(Updating, chat, (es) => turnsDone(es) >= 2)
      }).pipe(Effect.provide(runMemory(Updating.toLayer(handler), model)))

      expect(AssistantEvent.assistantTexts(entries)).toEqual(["It's in Ontario."])
      expect(entries.flatMap(({ event }) => (AssistantEvent.isTurnEnd(event) ? [event._tag] : []))).toEqual([
        "TurnCompleted",
        "TurnCompleted"
      ])
    })
  )

  it.live("leaves an input the handler only read in the entries to the next turn", () =>
    Effect.gen(function* () {
      const read = yield* Deferred.make<void>()
      const submitted = yield* Deferred.make<void>()
      let turns = 0

      // The first turn reads the history, then an update lands, and it reads the entries (like a summary would).
      const handler = Effect.fn(function* (turn: Assistant.Turn<Update>) {
        turns += 1
        yield* turn.history()

        if (turns === 1) {
          yield* Deferred.succeed(read, undefined)
          yield* Deferred.await(submitted)
          yield* (yield* CurrentChat.CurrentChat).entries

          return waitOnly()
        }

        yield* CurrentChat.CurrentChat.use((chat) =>
          chat.append(AssistantEvent.AssistantMessage.make({ id: "answer", text: "It's in Ontario." }))
        )

        return Stream.empty
      })

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Updating).submit(chat, say("which province is Ottawa in?"))
        yield* Deferred.await(read)
        yield* (yield* Updating).submit(chat, update("specialist:research", { answer: "Ontario" }))
        yield* Deferred.succeed(submitted, undefined)

        return yield* collectUntil(Updating, chat, (es) => turnsDone(es) >= 2)
      }).pipe(Effect.provide(updatingAssistant(handler, Scripted.unused)))

      expect(AssistantEvent.assistantTexts(entries)).toEqual(["It's in Ontario."])
    })
  )

  it.live("replyIfOwed runs one pass that can only reply, with the nudge last", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(() => [
        Scripted.call("send_user_message", { text: "You're welcome.", wait: true })
      ])

      // The loop only calls wait, as a model might after answering a workflow's question.
      const handler = (turn: Assistant.Turn) =>
        waitOnly().pipe(Stream.concat(turn.replyIfOwed({ instructions: "Be brief.", nudge: "Reply now." })))

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("Thanks, that's all I needed."))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(memoryAssistant(handler, model.layer)))

      const [request] = yield* model.requests

      expect(Predicate.isTagged(lastTurnEnd(entries)!, "TurnCompleted")).toBe(true)
      expect(AssistantEvent.assistantTexts(entries)).toEqual(["You're welcome."])
      // The loop's prompt and tools, so the system prompt and tools stay cached; the nudge comes after the history.
      expect(request?.tools).toEqual(["send_user_message", "wait"])
      // Not forced, since some models refuse that: text it writes instead goes out as the reply.
      expect(request?.toolChoice).toBe("auto")
      expect(request?.system.endsWith("Be brief.")).toBe(true)
      expect(Scripted.lastInput(request!)).toBe("Reply now.")
    })
  )
})

describe("the reply pass", () => {
  it.live("refuses any call but a reply, and the model replies next", () =>
    Effect.gen(function* () {
      let step = 0

      const model = yield* Scripted.make(() =>
        ++step === 1 ? Scripted.wait() : step === 2 ? Scripted.wait() : Scripted.reply("Anytime.")
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("Thanks!"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(memoryAssistant(simple({ instructions: "Be brief." }), model.layer)))

      const refused = entries.flatMap(({ event }) =>
        Predicate.isTagged(event, "ToolResult") && event.outcome === "failure" ? [event.tool] : []
      )

      expect(refused).toEqual(["wait"])
      expect(AssistantEvent.assistantTexts(entries)).toEqual(["Anytime."])
      expect(Predicate.isTagged(lastTurnEnd(entries)!, "TurnCompleted")).toBe(true)
    })
  )
})

describe("progress without a result", () => {
  it.live("gets one more pass to deliver, after it said it was on it and waited", () =>
    Effect.gen(function* () {
      let step = 0

      const model = yield* Scripted.make((request) => {
        step += 1

        if (Scripted.lastInput(request) === deliveryNudge)
          return Scripted.reply("Two orders are open: #1041 and #1042.")

        if (step === 1) return [Scripted.call("send_user_message", { text: "Checking.", wait: false })]

        return Scripted.wait()
      })

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("What's still open?"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(memoryAssistant(simple({ instructions: "Be brief." }), model.layer)))

      expect(AssistantEvent.assistantTexts(entries)).toEqual(["Checking.", "Two orders are open: #1041 and #1042."])
    })
  )

  it.live("delivers what it writes as text after its progress, and the turn completes", () =>
    Effect.gen(function* () {
      let step = 0

      // After its first calls, it writes the answer instead of sending it.
      const model = yield* Scripted.make(() =>
        ++step === 1
          ? [Scripted.call("send_user_message", { text: "Checking.", wait: false })]
          : [Scripted.text("Two orders are open: #1041 and #1042.")]
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("What's still open?"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(memoryAssistant(simple({ instructions: "Be brief." }), model.layer)))

      const sent = entries.flatMap(({ event }) =>
        Predicate.isTagged(event, "ToolResult") && event.tool === "send_user_message" ? [event.outcome] : []
      )

      expect(AssistantEvent.assistantTexts(entries)).toEqual(["Checking.", "Two orders are open: #1041 and #1042."])
      // Sent the way a call sends, and the answer: no pass to deliver.
      expect(sent).toEqual(["success", "success"])
      expect(step).toBe(2)
      expect(Predicate.isTagged(lastTurnEnd(entries)!, "TurnCompleted")).toBe(true)
    })
  )

  it.live("delivers what it writes as text in the pass to deliver, where wait is refused", () =>
    Effect.gen(function* () {
      let step = 0

      const model = yield* Scripted.make((request) => {
        step += 1

        if (step === 1) return [Scripted.call("send_user_message", { text: "Checking.", wait: false })]

        if (Scripted.lastInput(request) === deliveryNudge)
          return [Scripted.text("Two orders are open: #1041 and #1042.")]

        return Scripted.wait()
      })

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("What's still open?"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(memoryAssistant(simple({ instructions: "Be brief." }), model.layer)))

      const delivery = (yield* model.requests).filter((request) => Scripted.lastInput(request) === deliveryNudge)

      // One pass to deliver, not forced, where only sending runs.
      expect(delivery.map((request) => request.toolChoice)).toEqual(["auto"])
      expect(AssistantEvent.assistantTexts(entries)).toEqual(["Checking.", "Two orders are open: #1041 and #1042."])
      expect(Predicate.isTagged(lastTurnEnd(entries)!, "TurnCompleted")).toBe(true)
    })
  )

  it.live("sends text next to a call as nothing more: the call's message goes out once", () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(() => [
        Scripted.text("Let me answer."),
        ...Scripted.reply("Two orders are open: #1041 and #1042.")
      ])

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("What's still open?"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(memoryAssistant(simple({ instructions: "Be brief." }), model.layer)))

      expect(AssistantEvent.assistantTexts(entries)).toEqual(["Two orders are open: #1041 and #1042."])
      expect(Predicate.isTagged(lastTurnEnd(entries)!, "TurnCompleted")).toBe(true)
    })
  )

  it.live("doesn't ask again when the progress message was the last word", () =>
    Effect.gen(function* () {
      let step = 0

      const model = yield* Scripted.make(() =>
        ++step === 1 ? Scripted.reply("Done: both are open.") : Scripted.wait()
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("What's still open?"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(memoryAssistant(simple({ instructions: "Be brief." }), model.layer)))

      expect(AssistantEvent.assistantTexts(entries)).toEqual(["Done: both are open."])
      expect(step).toBe(1)
    })
  )
})

describe("a turn's trace", () => {
  const turnStarts = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
    entries.flatMap(({ event }) => (Predicate.isTagged(event, "TurnStarted") ? [event] : []))

  const oneTurn = Effect.gen(function* () {
    const chat = yield* newChat
    yield* (yield* Updating).submit(chat, update("workflow:Export", { status: "done" }))

    return yield* collectUntil(Updating, chat, (es) => turnsDone(es) >= 1)
  })

  it.live("is in TurnStarted when a tracer records it", () =>
    Effect.gen(function* () {
      const traceIds: Array<string> = []

      const recording = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          traceIds.push(span.traceId)

          return span
        }
      })

      const entries = yield* oneTurn.pipe(Effect.provide(updatingLayer), Effect.withTracer(recording))
      const [started] = turnStarts(entries)

      expect(started?.traceId).toBeDefined()
      expect(traceIds).toContain(started?.traceId)
    })
  )

  it.live("isn't there with Effect's own tracer, which exports nothing", () =>
    Effect.gen(function* () {
      const [started] = turnStarts(yield* oneTurn.pipe(Effect.provide(updatingLayer)))

      expect(started).toBeDefined()
      expect(started?.traceId).toBeUndefined()
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
            block: AssistantEvent.MessageBlock.make({
              kind: "choose_one",
              props: { options: ["red", "blue"] }
            })
          }),
          say("hmm")
        ])
        yield* (yield* TestAssistant).submit(chat, say("something else"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(layer))

      expect(
        entries.flatMap(({ event }) => (Predicate.isTagged(event, "BlocksClosed") ? event.messageIds : []))
      ).toEqual(["m1"])
      expect(BlockKit.fromEntries(entries).get("m1")?.open).toBe(false)
    })
  )
})
