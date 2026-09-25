import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { describe, expect, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { Assistant, AssistantTurn, ChatId, Specialist } from "../src/index.ts"
import { fact, runEntity, runMemory, say } from "./fixtures.ts"

interface User {
  readonly name: string
  readonly admin: boolean
}

class CurrentUser extends Context.Service<CurrentUser, User>()("test/CurrentUser") {}

const alice: User = { name: "Alice", admin: true }

const bob: User = { name: "Bob", admin: false }

/** The app's chat table: whose chat each one is. */
const owners = new Map<ChatId.ChatId, User>()

/** A new chat for the user, as the app would create it. */
const chatFor = (user: User) =>
  Effect.sync(() => {
    const chatId = ChatId.make()
    owners.set(chatId, user)

    return chatId
  })

/** The app's lookup: whose chat is it. */
class ChatUsers
  extends Context.Service<ChatUsers, { readonly forChat: (chatId: ChatId.ChatId) => Effect.Effect<User> }>()(
    "test/ChatUsers"
  )
{}

const ChatUsersLive = Layer.succeed(ChatUsers)({
  forChat: (chatId) => Effect.sync(() => owners.get(chatId) ?? bob)
})

interface Seen {
  readonly by: string
  readonly instructions: string
  readonly tools: ReadonlyArray<string>
}

/** Records whom its run is for, instead of calling the model. */
const Clerk = Specialist.make("clerk", { description: "Files things." })

const clerkLive = (seen: Queue.Queue<Seen>) =>
  Clerk.toLayer(Effect.gen(function*() {
    const users = yield* ChatUsers

    return Effect.fn(function*(run: Specialist.Run) {
      const user = yield* users.forChat(run.chatId)
      yield* Queue.offer(seen, { by: "clerk", instructions: `You file for ${user.name}.`, tools: [] })

      return Stream.empty
    })
  }))

const adminReport = Tool.make({
  name: "admin_report",
  description: "Admins only.",
  inputSchema: Tool.noInput,
  run: () => Effect.succeed("report")
})

const greet = Tool.make({
  name: "greet",
  description: "Greets the current user.",
  inputSchema: Tool.noInput,
  run: () => Effect.map(CurrentUser, (user) => `hi ${user.name}`)
})

/**
 * A handler that records what a turn got instead of calling the model, and
 * hands a "file it" message to the clerk. It looks the user up from the
 * turn's chat and provides it to the turn, as an app's handler would.
 */
const recording = (seen: Queue.Queue<Seen>) =>
  Effect.gen(function*() {
    const users = yield* ChatUsers

    return Effect.fn(function*(turn: Assistant.Turn) {
      const user = yield* users.forChat(turn.chatId)

      return Effect.gen(function*() {
        const current = yield* CurrentUser
        // This turn's tools: only admins get the report.
        const toolkit = current.admin ? Toolkit.make(adminReport, greet) : Toolkit.make(greet)
        yield* Queue.offer(seen, {
          by: "assistant",
          instructions: `You help ${current.name}.`,
          tools: Object.keys(toolkit)
        })

        const history = JSON.stringify(yield* turn.history)

        // The clerk's report arrives as a <specialist> input: file only once.
        if (history.includes("file it") && !history.includes(`name=\\"clerk\\"`)) {
          const runner = yield* Specialist.Runner
          yield* runner.spawn({ turn: yield* AssistantTurn.AssistantTurn, kind: "clerk", brief: { goal: "File it." } })
        }
      }).pipe(Effect.provideService(CurrentUser, user), Stream.fromEffect, Stream.drain)
    })
  })

const Helper = Assistant.make("helper", { specialists: [Clerk] })

const handlers = (seen: Queue.Queue<Seen>) =>
  Helper.toLayer(recording(seen)).pipe(Layer.provide(clerkLive(seen)), Layer.provide(ChatUsersLive))

const engines = {
  memory: (seen: Queue.Queue<Seen>) => runMemory(handlers(seen)),
  cluster: (seen: Queue.Queue<Seen>) => runEntity(handlers(seen))
}

for (const [name, engine] of Object.entries(engines)) {
  describe(`whom a turn acts for (${name})`, () => {
    it.live("acts for the chat's user", () =>
      Effect.gen(function*() {
        const seen = yield* Queue.unbounded<Seen>()

        yield* Effect.gen(function*() {
          yield* Helper.submit(yield* chatFor(alice), say("hi"))
          const first = yield* Queue.take(seen)
          yield* Helper.submit(yield* chatFor(bob), say("hi"))
          const second = yield* Queue.take(seen)

          expect(first.instructions).toContain("You help Alice.")
          expect(first.tools).toContain("admin_report")
          expect(second.instructions).toContain("You help Bob.")
          expect(second.tools).toContain("greet")
          expect(second.tools).not.toContain("admin_report")
        }).pipe(Effect.provide(engine(seen)))
      }))

    it.live("runs a specialist, and the turn for its answer, for the chat's user", () =>
      Effect.gen(function*() {
        const seen = yield* Queue.unbounded<Seen>()

        yield* Effect.gen(function*() {
          yield* Helper.submit(yield* chatFor(bob), say("file it"))
          yield* Queue.take(seen)

          expect(yield* Queue.take(seen)).toEqual({ by: "clerk", instructions: "You file for Bob.", tools: [] })
          // The clerk's answer is a fact in the chat: a turn reads it, for Bob too.
          expect((yield* Queue.take(seen)).instructions).toContain("You help Bob.")
        }).pipe(Effect.provide(engine(seen)))
      }))

    it.live("gives a fact's turn the chat's user", () =>
      Effect.gen(function*() {
        const seen = yield* Queue.unbounded<Seen>()

        yield* Effect.gen(function*() {
          yield* Helper.submit(yield* chatFor(bob), fact("workflow:Export", { status: "done" }))

          expect((yield* Queue.take(seen)).instructions).toContain("You help Bob.")
        }).pipe(Effect.provide(engine(seen)))
      }))
  })
}
