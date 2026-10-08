import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Assistant, AssistantEvent, ChatId, ChatLog, Chats, Specialist } from "../src/index.ts"
import {
  collectUntil,
  newChat,
  runEntity,
  runMemory,
  say,
  turnsDone,
  update,
  UpdateEvent,
  withHandlers
} from "./utils/fixtures.ts"
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

const logOf = (chat: ChatId.ChatId) => ChatLog.ChatLog.use((log) => log.read(chat))

const tags = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) => entries.map(({ event }) => event._tag)

/** The chats an app keeps: `deleted` marks one deleted, as the app's own delete would. */
const appChats = Effect.gen(function* () {
  const known = yield* Ref.make(new Map<ChatId.ChatId, "open" | "deleted">())

  const layer = Layer.succeed(Chats.Chats, {
    get: (chatId) =>
      Ref.get(known).pipe(
        Effect.flatMap((all) => {
          const status = all.get(chatId)

          return status === "open"
            ? Effect.succeed({ chatId })
            : Effect.fail(Chats.ChatUnavailable.make({ chatId, reason: status === "deleted" ? "Deleted" : "NotFound" }))
        })
      )
  })

  return {
    layer,
    create: (chatId: ChatId.ChatId) => Ref.update(known, (all) => new Map(all).set(chatId, "open")),
    remove: (chatId: ChatId.ChatId) => Ref.update(known, (all) => new Map(all).set(chatId, "deleted"))
  }
})

for (const [name, run] of Object.entries(engines)) {
  describe(`deleting a chat (${name})`, () => {
    it.live("ends its log with ChatDeleted, once, and drops later inputs and events, quietly", () =>
      Effect.gen(function* () {
        const layer = run(
          Deleting.toLayer((turn) => turn.loop({ instructions: "Be brief." })).pipe(
            Layer.provide(slowLive(yield* signals))
          ),
          Scripted.layer(() => Scripted.reply("Hi."))
        )

        const { after, streamed } = yield* Effect.gen(function* () {
          const chat = yield* newChat
          yield* (yield* Deleting).submit(chat, say("hi"))
          yield* collectUntil(Deleting, chat, (es) => turnsDone(es) >= 1)

          yield* (yield* Deleting).delete(chat)
          yield* (yield* Deleting).delete(chat)
          yield* (yield* Deleting).submit(chat, say("are you there?"))
          yield* (yield* Deleting).submit(chat, update("workflow:Export", { status: "done" }))
          yield* Effect.sleep("200 millis")

          return {
            after: yield* logOf(chat),
            streamed: yield* (yield* Deleting).subscribe(chat).pipe(Stream.runCollect, Effect.timeout("5 seconds"))
          }
        }).pipe(Effect.provide(layer))

        // The log stays: the chat as it was, then the one ChatDeleted, and nothing after.
        expect(tags(after).slice(0, 1)).toEqual(["UserMessage"])
        expect(tags(after).at(-1)).toBe("ChatDeleted")
        expect(tags(after).filter((tag) => tag === "ChatDeleted")).toHaveLength(1)
        expect(after.map(({ event }) => event).filter((event) => Predicate.isTagged(event, "Update"))).toEqual([])
        // A subscriber after the delete gets the log, and its stream ends.
        expect(tags([...streamed])).toEqual(tags(after))
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
          const subscriber = yield* Effect.forkChild((yield* Deleting).subscribe(chat).pipe(Stream.runCollect))
          yield* (yield* Deleting).submit(chat, say("hi"))
          yield* Deferred.await(signal.started)

          yield* (yield* Deleting).delete(chat)
          yield* Deferred.await(signal.interrupted).pipe(Effect.timeout("5 seconds"))
          const streamed = yield* Fiber.join(subscriber).pipe(Effect.timeout("5 seconds"))

          return { log: yield* logOf(chat), streamed }
        }).pipe(Effect.provide(layer))

        expect(tags(after.log).at(-1)).toBe("ChatDeleted")
        // The subscriber got the ChatDeleted, then its stream ended.
        expect(tags([...after.streamed]).at(-1)).toBe("ChatDeleted")
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
          yield* (yield* Deleting).submit(chat, update("workflow:Research", { status: "started" }))
          yield* Deferred.await(signal.started)

          yield* (yield* Deleting).delete(chat)
          yield* Deferred.await(signal.interrupted).pipe(Effect.timeout("5 seconds"))
          yield* Effect.sleep("100 millis")

          return yield* logOf(chat)
        }).pipe(Effect.provide(layer))

        // The run's report never arrives: the log ends where the chat was deleted.
        expect(tags(after).at(-1)).toBe("ChatDeleted")
        expect(tags(after)).not.toContain("SpecialistFinished")
      })
    )

    it.live("refuses a submit for a chat the app doesn't know, or deleted", () =>
      Effect.gen(function* () {
        const chats = yield* appChats

        const layer = run(
          Deleting.toLayer((turn) => turn.loop({ instructions: "Be brief." })).pipe(
            Layer.provide(slowLive(yield* signals))
          ),
          Scripted.layer(() => Scripted.reply("Hi."))
        ).pipe(Layer.provideMerge(chats.layer))

        const { unknown, deleted, log } = yield* Effect.gen(function* () {
          const chat = yield* newChat
          const unknown = yield* Effect.flip((yield* Deleting).submit(chat, say("hi")))

          yield* chats.create(chat)
          yield* chats.remove(chat)

          const deleted = yield* Effect.flip((yield* Deleting).submit(chat, say("hi")))

          return { unknown, deleted, log: yield* logOf(chat) }
        }).pipe(Effect.provide(layer))

        expect(unknown.reason).toBe("NotFound")
        expect(deleted.reason).toBe("Deleted")
        expect(tags(log)).not.toContain("UserMessage")
      })
    )

    it.live("deletes a chat the app deleted mid-turn, at the turn's next model call", () =>
      Effect.gen(function* () {
        const chats = yield* appChats
        const chatRef = yield* Ref.make<ChatId.ChatId | undefined>(undefined)

        // The model's first call closes the chat in the app; the second never comes.
        const Close = Tool.make("close_chat", { description: "Closes the chat.", success: Schema.String })

        const toolkit = withHandlers(Toolkit.make(Close), {
          close_chat: () =>
            Ref.get(chatRef).pipe(
              Effect.flatMap((chat) => (chat === undefined ? Effect.void : chats.remove(chat))),
              Effect.as("closed")
            )
        })

        const layer = run(
          Deleting.toLayer((turn) => turn.loop({ instructions: "Be brief.", toolkit: toolkit.toolkit })).pipe(
            Layer.provide(toolkit.toolkit.toLayer(toolkit.handlers)),
            Layer.provide(slowLive(yield* signals))
          ),
          Scripted.layer((request) =>
            Scripted.hasCalled(request, "close_chat") ? Scripted.reply("Still here.") : [Scripted.call("close_chat")]
          )
        ).pipe(Layer.provideMerge(chats.layer))

        const log = yield* Effect.gen(function* () {
          const chat = yield* newChat
          yield* Ref.set(chatRef, chat)
          yield* chats.create(chat)
          yield* (yield* Deleting).submit(chat, say("close it"))

          return yield* collectUntil(Deleting, chat, (es) => tags(es).includes("ChatDeleted"), "10 seconds")
        }).pipe(Effect.provide(layer))

        expect(tags(log).at(-1)).toBe("ChatDeleted")
        expect(tags(log).filter((tag) => tag === "ModelOutput")).toHaveLength(1)
        expect(tags(log)).not.toContain("AssistantMessage")
      })
    )
  })
}
