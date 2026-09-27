import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import {
  Assistant,
  AssistantChat,
  AssistantEngine,
  AssistantEvent,
  AssistantToolCall,
  ChatId,
  ChatLog
} from "../src/index.ts"
import { mayHaveRunOutput } from "../src/internal/history.ts"
import { say, testModel } from "./fixtures.ts"
import * as Scripted from "./scripted.ts"

const Resumer = Assistant.make("resumer")

/** A handler that says which chat it ran a turn for, instead of calling the model. */
const reporting = (ran: Deferred.Deferred<ChatId.ChatId>) =>
  Resumer.toLayer((turn) => Stream.fromEffect(Deferred.succeed(ran, turn.chatId)).pipe(Stream.drain))

describe("AssistantEngine.layerMemory", () => {
  it.live("picks up a chat whose turn a restart cut off", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const [cutOff, otherAssistant, finished] = yield* Effect.all([ChatId.make, ChatId.make, ChatId.make])

      // What the log holds after a restart.
      yield* log.append(cutOff, [say("hi"), AssistantEvent.TurnStarted.make({ assistant: "resumer" })])
      yield* log.append(otherAssistant, [say("hi"), AssistantEvent.TurnStarted.make({ assistant: "someone-else" })])
      yield* log.append(finished, [
        say("hi"),
        AssistantEvent.TurnStarted.make({ assistant: "resumer" }),
        AssistantEvent.TurnCompleted.make({ throughSeq: 1 })
      ])

      const ran = yield* Deferred.make<ChatId.ChatId>()

      const resumed = yield* Effect.scoped(
        Layer.build(
          reporting(ran).pipe(Layer.provide(AssistantEngine.layerMemory), Layer.provide(Scripted.unused))
        ).pipe(Effect.andThen(Deferred.await(ran)), Effect.timeout("5 seconds"))
      )

      expect(resumed).toBe(cutOff)
    }).pipe(Effect.provide(ChatLog.layerMemory))
  )
})

describe("tool calls after a crash", () => {
  it.live("runs a call the crash cut off again, with the same id and key, before the model goes on", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* ChatId.make
      const ran = yield* Deferred.make<{ readonly callId: string; readonly key: string }>()

      const sendReport = Tool.make({
        name: "send_report",
        description: "Sends the weekly report.",
        inputSchema: Tool.noInput,
        run: () =>
          Effect.gen(function* () {
            const call = yield* AssistantToolCall.AssistantToolCall
            yield* Deferred.succeed(ran, { callId: call.callId, key: yield* AssistantToolCall.idempotencyKey })

            return "sent"
          })
      })

      // What the log holds after a restart: the call started, and the process died before its result.
      yield* log.append(chat, [
        say("Send the weekly report."),
        AssistantEvent.TurnStarted.make({ assistant: "resumer" }),
        AssistantEvent.ModelOutput.make({
          items: [{ type: "function_call", call_id: "toolu_report_1", name: "send_report", arguments: "{}" }],
          seenThroughSeq: 2
        }),
        AssistantEvent.ToolStarted.make({ callId: "toolu_report_1", tool: "send_report" })
      ])

      const handlers = Resumer.toLayer((turn) =>
        turn.loop({
          model: testModel,
          instructions: "You help a small team. Be brief.",
          toolkit: Toolkit.make(sendReport)
        })
      )

      const call = yield* Effect.scoped(
        Layer.build(
          handlers.pipe(
            Layer.provide(AssistantEngine.layerMemory),
            Layer.provide(Scripted.layer(() => Scripted.reply("Done.")))
          )
        ).pipe(Effect.andThen(Deferred.await(ran)), Effect.timeout("60 seconds"))
      )

      expect(call).toEqual({ callId: "toolu_report_1", key: "tool-call:toolu_report_1" })
    }).pipe(Effect.provide(ChatLog.layerMemory))
  )
})

describe("destructive tool calls after a crash", () => {
  it.live("doesn't run a destructive call again, and tells the model it may have run", () =>
    Effect.gen(function* () {
      const log = yield* ChatLog.ChatLog
      const chat = yield* ChatId.make
      let sent = 0

      const sendEmail = AssistantToolCall.destructive(
        Tool.make({
          name: "send_email",
          description: "Sends the email.",
          inputSchema: Tool.noInput,
          run: () => Effect.sync(() => (sent += 1)).pipe(Effect.as("sent"))
        })
      )

      yield* log.append(chat, [
        say("Send the email."),
        AssistantEvent.TurnStarted.make({ assistant: "resumer" }),
        AssistantEvent.ModelOutput.make({
          items: [{ type: "function_call", call_id: "toolu_email_1", name: "send_email", arguments: "{}" }],
          seenThroughSeq: 2
        }),
        AssistantEvent.ToolStarted.make({ callId: "toolu_email_1", tool: "send_email" })
      ])

      const handlers = Resumer.toLayer((turn) =>
        turn.loop({
          model: testModel,
          instructions: "You help a small team. Be brief.",
          toolkit: Toolkit.make(sendEmail)
        })
      )

      const result = yield* Effect.scoped(
        Layer.build(
          handlers.pipe(
            Layer.provide(AssistantEngine.layerMemory),
            Layer.provide(Scripted.layer(() => Scripted.reply("Done.")))
          )
        ).pipe(
          Effect.andThen(
            log.read(chat).pipe(
              Effect.map((entries) =>
                entries.flatMap(({ event }) =>
                  Predicate.isTagged(event, "ToolResult") && event.callId === "toolu_email_1" ? [event.output] : []
                )
              ),
              Effect.filterOrFail((outputs) => outputs.length > 0),
              Effect.retry(Schedule.spaced("100 millis")),
              Effect.timeout("30 seconds")
            )
          )
        )
      )

      expect(result).toEqual([mayHaveRunOutput])
      expect(sent).toBe(0)
    }).pipe(Effect.provide(ChatLog.layerMemory))
  )
})

describe("a chat's log", () => {
  /** Storage that's slow to find the last seq: two unlocked appends would both number after the same one. */
  const slowStorage = Effect.gen(function* () {
    const stored = yield* Ref.make<ReadonlyArray<AssistantEvent.Entry>>([])

    return ChatLog.make({
      read: (chatId) => Ref.get(stored).pipe(Effect.map((all) => all.filter((entry) => entry.chatId === chatId))),
      lastSeq: (chatId) =>
        Ref.get(stored).pipe(
          Effect.delay("20 millis"),
          Effect.map((all) => all.filter((entry) => entry.chatId === chatId).at(-1)?.seq ?? 0)
        ),
      write: (_, entries) => Ref.update(stored, (all) => [...all, ...entries]),
      lastEntries: Effect.succeed([])
    })
  })

  it.live("numbers a chat's writes in order, however many write at once", () =>
    Effect.gen(function* () {
      const handler = Resumer.toLayer(() =>
        Stream.fromEffect(
          Effect.gen(function* () {
            // The chat's appends take its lock.
            const chat = yield* AssistantChat.AssistantChat
            yield* Effect.all([chat.append([say("a")]), chat.append([say("b"), say("c")])], {
              concurrency: "unbounded"
            })
          })
        ).pipe(Stream.drain)
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* ChatId.make
        yield* Resumer.submit(chat, say("go"))

        return yield* Resumer.subscribe(chat).pipe(
          Stream.takeUntil(({ event }) => AssistantEvent.isTurnEnd(event)),
          Stream.runCollect
        )
      }).pipe(
        Effect.provide(handler.pipe(Layer.provideMerge(AssistantEngine.layerMemory), Layer.provide(Scripted.unused))),
        Effect.provide(Layer.effect(ChatLog.ChatLog, slowStorage))
      )

      expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, i) => i + 1))
    })
  )

  it.live("streams a chat's stored entries, then live ones, and only that chat's", () =>
    Effect.gen(function* () {
      const handler = Resumer.toLayer(() => Stream.empty)

      const texts = yield* Effect.gen(function* () {
        const [chat, other] = yield* Effect.all([ChatId.make, ChatId.make])
        yield* Resumer.submit(chat, say("stored"))

        const collected = yield* Resumer.subscribe(chat).pipe(
          Stream.filter(({ event }) => Predicate.isTagged(event, "UserMessage")),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild
        )

        yield* Effect.sleep("50 millis")
        yield* Resumer.submit(other, say("another chat"))
        yield* Resumer.submit(chat, say("live 1"))
        yield* Resumer.submit(chat, say("live 2"))

        return (yield* Fiber.join(collected)).flatMap(({ event }) =>
          Predicate.isTagged(event, "UserMessage") ? [event.text] : []
        )
      }).pipe(
        Effect.provide(handler.pipe(Layer.provideMerge(AssistantEngine.layerMemory), Layer.provide(Scripted.unused))),
        Effect.provide(ChatLog.layerMemory)
      )

      expect(texts).toEqual(["stored", "live 1", "live 2"])
    })
  )
})

describe("a handler's build", () => {
  it.live("runs once per chat, not once per turn, with the chat's id", () =>
    Effect.gen(function* () {
      const builds: Array<ChatId.ChatId> = []

      const handler = Resumer.toLayer(
        Effect.gen(function* () {
          const { chatId } = yield* AssistantChat.AssistantChat
          builds.push(chatId)

          return () => Stream.empty
        })
      )

      const [chat, other] = yield* Effect.all([ChatId.make, ChatId.make])

      yield* Effect.gen(function* () {
        const turnsIn = (chatId: ChatId.ChatId, count: number) =>
          Resumer.subscribe(chatId).pipe(
            Stream.filter(({ event }) => AssistantEvent.isTurnEnd(event)),
            Stream.take(count),
            Stream.runDrain
          )

        yield* Resumer.submit(chat, say("one"))
        yield* turnsIn(chat, 1)
        yield* Resumer.submit(chat, say("two"))
        yield* turnsIn(chat, 2)
        yield* Resumer.submit(other, say("hi"))
        yield* turnsIn(other, 1)
      }).pipe(
        Effect.provide(handler.pipe(Layer.provideMerge(AssistantEngine.layerMemory), Layer.provide(Scripted.unused))),
        Effect.provide(ChatLog.layerMemory)
      )

      expect(builds).toEqual([chat, other])
    })
  )
})
