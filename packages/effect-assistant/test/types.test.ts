import { describe, expectTypeOf, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Prompt from "effect/unstable/ai/Prompt"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import {
  AppEvent,
  Assistant,
  type AssistantEngine,
  type AssistantEvent,
  AssistantLoop,
  type ChatId,
  Specialist
} from "../src/index.ts"

class CurrentUser extends Context.Service<CurrentUser, { readonly name: string }>()("types/CurrentUser") {}

class ChatUsers extends Context.Service<
  ChatUsers,
  { readonly forChat: (chatId: ChatId.ChatId) => Effect.Effect<{ name: string }> }
>()("types/ChatUsers") {}

class Prompts extends Context.Service<Prompts, { readonly get: Effect.Effect<string> }>()("types/Prompts") {}

const Clerk = Specialist.make("clerk", { description: "Files things." })

const WithClerk = Assistant.make("types-with-clerk", { specialists: [Clerk] })

/** What `WithClerk.toLayer` needs besides what its build required. */
type Registered<R = never> = Layer.Layer<
  never,
  never,
  AssistantEngine.AssistantEngine | LanguageModel.LanguageModel | Specialist.SpecialistHandler<"clerk"> | R
>

describe("types", () => {
  it("registers with the engine, and needs the model and the specialists' handlers", () => {
    const handlers = WithClerk.toLayer((turn) => turn.loop({ instructions: "Help." }))

    expectTypeOf(handlers).toEqualTypeOf<Registered>()
  })

  it("submits any input through the engine: a message, a block answer, or a fact", () => {
    expectTypeOf(WithClerk.submit).toEqualTypeOf<
      (
        chatId: ChatId.ChatId,
        input: AssistantEvent.Input
      ) => Effect.Effect<void, never, AssistantEngine.AssistantEngine>
    >()
  })

  it("lets a handler provide what its tools need, from the chat", () => {
    const Greet = Tool.make("greet", {
      description: "Greets the current user.",
      success: Schema.String,
      dependencies: [CurrentUser]
    })

    const greet = AssistantLoop.tools(Toolkit.make(Greet), {
      greet: () => CurrentUser.useSync((user) => `hi ${user.name}`)
    })

    expectTypeOf(greet).toEqualTypeOf<AssistantLoop.Tools<CurrentUser>>()

    const handlers = WithClerk.toLayer(
      Effect.gen(function* () {
        const users = yield* ChatUsers

        return (turn: Assistant.Turn) =>
          Stream.unwrap(
            Effect.map(users.forChat(turn.chatId), (user) =>
              turn.loop({ instructions: "Help.", toolkit: greet }).pipe(Stream.provideService(CurrentUser, user))
            )
          )
      })
    )

    expectTypeOf(handlers).toEqualTypeOf<Registered<ChatUsers>>()

    const unprovided = (turn: Assistant.Turn) => turn.loop({ instructions: "Help.", toolkit: greet })

    // @ts-expect-error: the tool uses CurrentUser, which nothing provides
    const reachesForUser = () => WithClerk.toLayer(unprovided)

    expectTypeOf(reachesForUser).toBeFunction()
  })

  it("lets a handler use what its build Effect required, and nothing else", () => {
    const clerk = Clerk.toLayer(
      Effect.gen(function* () {
        const prompts = yield* Prompts // build time: a requirement of the layer

        return (run: Specialist.Run) =>
          Stream.unwrap(
            Effect.gen(function* () {
              return run.loop({ instructions: `${yield* prompts.get} for ${run.chatId}` })
            })
          )
      })
    )

    expectTypeOf(clerk).toEqualTypeOf<Layer.Layer<Specialist.SpecialistHandler<"clerk">, never, Prompts>>()

    const usesPrompts = (run: Specialist.Run) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Prompts

          return run.loop({ instructions: "File it." })
        })
      )

    // @ts-expect-error: Prompts isn't required by the build Effect
    const reachesForPrompts = () => Clerk.toLayer(usesPrompts)

    expectTypeOf(reachesForPrompts).toBeFunction()

    const assistant = WithClerk.toLayer(
      Effect.gen(function* () {
        const prompts = yield* Prompts

        return Effect.fn(function* (turn: Assistant.Turn) {
          return turn.loop({ instructions: `${yield* prompts.get} for ${turn.chatId}` })
        })
      })
    )

    expectTypeOf(assistant).toEqualTypeOf<Registered<Prompts>>()

    const usesUser = Effect.fn(function* (turn: Assistant.Turn) {
      const user = yield* CurrentUser

      return turn.loop({ instructions: `Help ${user.name}.` })
    })

    // @ts-expect-error: CurrentUser is neither provided by the turn nor required by the build Effect
    const undeclaredUser = () => WithClerk.toLayer(usesUser)

    expectTypeOf(undeclaredUser).toBeFunction()
  })

  it("compiles the docs' examples", () => {
    // guide/specialists.md: a semaphore, a user looked up from the chat, another model.
    const analyst = Clerk.toLayer(
      Effect.gen(function* () {
        const users = yield* ChatUsers
        const permits = yield* Semaphore.make(3)

        return (run) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(permits.take(1), () => permits.release(1))
              const user = yield* users.forChat(run.chatId)

              return run.loop({ instructions: `Research for ${user.name}.`, maxSteps: 12 })
            })
          )
      })
    )

    expectTypeOf(analyst).toEqualTypeOf<Layer.Layer<Specialist.SpecialistHandler<"clerk">, never, ChatUsers>>()

    // guide/loops.md: the latest part of the history, from a user message.
    const recent = (messages: ReadonlyArray<Prompt.Message>, max: number) => {
      const from = messages.findIndex((message, i) => i >= messages.length - max && message.role === "user")

      return from === -1 ? messages : messages.slice(from)
    }

    const trimmed = WithClerk.toLayer((turn) =>
      AssistantLoop.stream({
        instructions: turn.instructions("Help."),
        toolkit: turn.tools,
        history: Effect.map(turn.history(), (history) => ({
          ...history,
          messages: recent(history.messages, 50)
        })),
        toolChoice: "required"
      })
    )

    expectTypeOf(trimmed).toEqualTypeOf<Registered>()
  })

  it("takes a toolkit's handlers from the build Effect, and their services from its layer", () => {
    class Orders extends Context.Service<Orders, { readonly recent: Effect.Effect<ReadonlyArray<string>> }>()(
      "types/Orders"
    ) {}

    const OrderHistory = Tool.make("order_history", {
      description: "Recent orders.",
      success: Schema.Array(Schema.String)
    })

    const OrderTools = Toolkit.make(OrderHistory)

    const OrderToolsLive = OrderTools.toLayer(
      Effect.gen(function* () {
        const orders = yield* Orders

        return { order_history: () => orders.recent }
      })
    )

    const handlers = WithClerk.toLayer(
      Effect.gen(function* () {
        const toolkit = AssistantLoop.tools(yield* OrderTools)

        return (turn: Assistant.Turn) => turn.loop({ instructions: "Help.", toolkit })
      })
    )

    expectTypeOf(handlers).toEqualTypeOf<Registered<Tool.Handler<"order_history">>>()
    expectTypeOf(handlers.pipe(Layer.provide(OrderToolsLive))).toEqualTypeOf<Registered<Orders>>()

    const unresolved = (turn: Assistant.Turn) =>
      turn.loop({ instructions: "Help.", toolkit: AssistantLoop.tools(OrderTools) })

    // @ts-expect-error: the toolkit's handlers aren't in the build's context
    const unstated = () => WithClerk.toLayer(unresolved)

    expectTypeOf(unstated).toBeFunction()
  })

  it("types the app's own events on the turn", () => {
    class Summary extends Schema.TaggedClass<Summary>()("Summary", { text: Schema.String }) {}

    class Other extends Schema.TaggedClass<Other>()("Other", { n: Schema.Number }) {}

    const Compacting = Assistant.make("types-compacting", { events: [AppEvent.make(Summary)] })

    const handlers = Compacting.toLayer((turn) => {
      expectTypeOf(turn.entries).toEqualTypeOf<Effect.Effect<ReadonlyArray<Assistant.Entry<Summary>>>>()

      const ok = turn.append(Summary.make({ text: "so far" }))

      // @ts-expect-error: Other isn't one of this assistant's events
      const wrong = turn.append(Other.make({ n: 1 }))

      void [ok, wrong]

      return turn.loop({ instructions: "Help." })
    })

    const submit = (chatId: ChatId.ChatId) => {
      const ok = Compacting.submit(chatId, Summary.make({ text: "so far" }))

      // @ts-expect-error: Other isn't one of this assistant's events
      const wrong = Compacting.submit(chatId, Other.make({ n: 1 }))

      return [ok, wrong]
    }

    expectTypeOf(handlers).toBeObject()
    expectTypeOf(submit).toBeFunction()
  })
})
