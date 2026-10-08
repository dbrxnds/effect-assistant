import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { Assistant, ChatLog, Specialist } from "../src/index.ts"
import { collectUntil, newChat, runEntity, runMemory, say, turnsDone, update, UpdateEvent } from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const engines = { memory: runMemory, cluster: runEntity }

/** A run that works until it's stopped, and says when it started and when it was interrupted. */
const Slow = Specialist.make("slow", { description: "Takes its time." })

const Deleting = Assistant.make("deleting", { specialists: [Slow], events: [UpdateEvent] })

interface Signals {
  readonly started: Deferred.Deferred<void>
  readonly interrupted: Deferred.Deferred<void>
}

const signals = Effect.all({ started: Deferred.make<void>(), interrupted: Deferred.make<void>() })

/** Works forever from the moment it starts, until it's interrupted. */
const hang = (signal: Signals) =>
  Deferred.succeed(signal.started, undefined).pipe(
    Effect.andThen(Effect.never),
    Effect.onInterrupt(() => Deferred.succeed(signal.interrupted, undefined))
  )

const slowLive = (signal: Signals) => Slow.toLayer(() => Stream.fromEffect(hang(signal)).pipe(Stream.drain))

const logOf = (chat: Parameters<typeof Deleting.delete>[0]) => ChatLog.ChatLog.use((log) => log.read(chat))

for (const [name, run] of Object.entries(engines)) {
  describe(`deleting a chat (${name})`, () => {
    it.live("removes its log, and later inputs and events for it are dropped, quietly", () =>
      Effect.gen(function* () {
        const layer = run(
          Deleting.toLayer((turn) => turn.loop({ instructions: "Be brief." })).pipe(
            Layer.provide(slowLive(yield* signals))
          ),
          Scripted.layer(() => Scripted.reply("Hi."))
        )

        const { after, deleted, streamed } = yield* Effect.gen(function* () {
          const chat = yield* newChat
          yield* Deleting.submit(chat, say("hi"))
          yield* collectUntil(Deleting, chat, (es) => turnsDone(es) >= 1)

          yield* Deleting.delete(chat)
          yield* Deleting.delete(chat)
          yield* Deleting.submit(chat, say("are you there?"))
          yield* Deleting.submit(chat, update("workflow:Export", { status: "done" }))
          yield* Effect.sleep("200 millis")

          return {
            after: yield* logOf(chat),
            deleted: yield* ChatLog.ChatLog.use((log) => log.isDeleted(chat)),
            streamed: yield* Deleting.subscribe(chat).pipe(Stream.runCollect, Effect.timeout("5 seconds"))
          }
        }).pipe(Effect.provide(layer))

        expect(after).toEqual([])
        expect(deleted).toBe(true)
        expect(streamed).toEqual([])
      })
    )

    it.live("stops a turn that's working, and ends its subscribers' streams", () =>
      Effect.gen(function* () {
        const signal = yield* signals

        const layer = run(
          Deleting.toLayer(() => Stream.fromEffect(hang(signal)).pipe(Stream.drain)).pipe(
            Layer.provide(slowLive(yield* signals))
          ),
          Scripted.unused
        )

        const after = yield* Effect.gen(function* () {
          const chat = yield* newChat
          const subscriber = yield* Effect.forkChild(Deleting.subscribe(chat).pipe(Stream.runCollect))
          yield* Deleting.submit(chat, say("hi"))
          yield* Deferred.await(signal.started)

          yield* Deleting.delete(chat)
          yield* Deferred.await(signal.interrupted).pipe(Effect.timeout("5 seconds"))
          yield* Fiber.join(subscriber).pipe(Effect.timeout("5 seconds"))

          return yield* logOf(chat)
        }).pipe(Effect.provide(layer))

        expect(after).toEqual([])
      })
    )

    it.live("stops a specialist run working in it, and drops its report", () =>
      Effect.gen(function* () {
        const signal = yield* signals

        const layer = run(
          Deleting.toLayer(() =>
            Stream.fromEffect(
              Specialist.Runner.use((runner) => runner.spawn({ kind: "slow", brief: { goal: "Take your time." } }))
            ).pipe(Stream.drain)
          ).pipe(Layer.provide(slowLive(signal))),
          Scripted.unused
        )

        const after = yield* Effect.gen(function* () {
          const chat = yield* newChat
          yield* Deleting.submit(chat, update("workflow:Research", { status: "started" }))
          yield* Deferred.await(signal.started)

          yield* Deleting.delete(chat)
          yield* Deferred.await(signal.interrupted).pipe(Effect.timeout("5 seconds"))
          yield* Effect.sleep("100 millis")

          return yield* logOf(chat)
        }).pipe(Effect.provide(layer))

        expect(after).toEqual([])
      })
    )
  })
}
