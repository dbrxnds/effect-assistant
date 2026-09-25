import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { describe, expectTypeOf, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"

import type * as LanguageModel from "@effect-uai/core/LanguageModel"
import {
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
    const handlers = WithClerk.toLayer((turn) => turn.loop({ model: "claude-haiku-4-5", instructions: "Help." }))

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
    const greet = Tool.make({
      name: "greet",
      description: "Greets the current user.",
      inputSchema: Tool.noInput,
      run: () => Effect.map(CurrentUser, (user) => `hi ${user.name}`)
    })

    const handlers = WithClerk.toLayer(
      Effect.gen(function* () {
        const users = yield* ChatUsers

        return (turn: Assistant.Turn) =>
          Stream.unwrap(
            Effect.map(users.forChat(turn.chatId), (user) =>
              turn
                .loop({ model: "claude-haiku-4-5", instructions: "Help.", toolkit: Toolkit.make(greet) })
                .pipe(Stream.provideService(CurrentUser, user))
            )
          )
      })
    )

    expectTypeOf(handlers).toEqualTypeOf<Registered<ChatUsers>>()

    const unprovided = (turn: Assistant.Turn) =>
      turn.loop({ model: "claude-haiku-4-5", instructions: "Help.", toolkit: Toolkit.make(greet) })

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
              return run.loop({ model: "claude-haiku-4-5", instructions: `${yield* prompts.get} for ${run.chatId}` })
            })
          )
      })
    )

    expectTypeOf(clerk).toEqualTypeOf<Layer.Layer<Specialist.SpecialistHandler<"clerk">, never, Prompts>>()

    const usesPrompts = (run: Specialist.Run) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Prompts

          return run.loop({ model: "claude-haiku-4-5", instructions: "File it." })
        })
      )

    // @ts-expect-error: Prompts isn't required by the build Effect
    const reachesForPrompts = () => Clerk.toLayer(usesPrompts)

    expectTypeOf(reachesForPrompts).toBeFunction()

    const assistant = WithClerk.toLayer(
      Effect.gen(function* () {
        const prompts = yield* Prompts

        return Effect.fn(function* (turn: Assistant.Turn) {
          return turn.loop({ model: "claude-haiku-4-5", instructions: `${yield* prompts.get} for ${turn.chatId}` })
        })
      })
    )

    expectTypeOf(assistant).toEqualTypeOf<Registered<Prompts>>()

    const usesUser = Effect.fn(function* (turn: Assistant.Turn) {
      const user = yield* CurrentUser

      return turn.loop({ model: "claude-haiku-4-5", instructions: `Help ${user.name}.` })
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

              return run.loop({ model: "claude-haiku-4-5", instructions: `Research for ${user.name}.`, maxSteps: 12 })
            })
          )
      })
    )

    expectTypeOf(analyst).toEqualTypeOf<Layer.Layer<Specialist.SpecialistHandler<"clerk">, never, ChatUsers>>()

    // guide/loops.md: the latest part of the history, from a user message.
    const recent = (items: ReadonlyArray<Items.HistoryItem>, max: number) => {
      const from = items.findIndex(
        (item, i) => i >= items.length - max && Items.isMessage(item) && item.role === "user"
      )

      return from === -1 ? items : items.slice(from)
    }

    const trimmed = WithClerk.toLayer((turn) =>
      AssistantLoop.stream({
        model: "claude-haiku-4-5",
        instructions: turn.instructions("Help."),
        toolkit: turn.tools,
        history: turn.history.pipe(Effect.map((items) => recent(items, 50))),
        toolChoice: "required"
      })
    )

    expectTypeOf(trimmed).toEqualTypeOf<Registered>()
  })

  it("takes a tool's services from the build Effect", () => {
    class Orders extends Context.Service<Orders, { readonly recent: Effect.Effect<ReadonlyArray<string>> }>()(
      "types/Orders"
    ) {}

    const orderHistory = Tool.make({
      name: "order_history",
      description: "Recent orders.",
      inputSchema: Tool.noInput,
      run: () => Effect.flatMap(Orders, (orders) => orders.recent)
    })

    const handlers = WithClerk.toLayer(
      Effect.gen(function* () {
        yield* Effect.context<Orders>()

        return (turn: Assistant.Turn) =>
          turn.loop({ model: "claude-haiku-4-5", instructions: "Help.", toolkit: Toolkit.make(orderHistory) })
      })
    )

    expectTypeOf(handlers).toEqualTypeOf<Registered<Orders>>()

    const usesOrders = (turn: Assistant.Turn) =>
      turn.loop({ model: "claude-haiku-4-5", instructions: "Help.", toolkit: Toolkit.make(orderHistory) })

    // @ts-expect-error: the tool uses Orders, which the build doesn't provide
    const unstated = () => WithClerk.toLayer(usesOrders)

    expectTypeOf(unstated).toBeFunction()
  })

  it("types the app's own events on the turn", () => {
    class Summary extends Schema.TaggedClass<Summary>()("Summary", { text: Schema.String }) {}

    class Other extends Schema.TaggedClass<Other>()("Other", { n: Schema.Number }) {}

    const Compacting = Assistant.make("types-compacting", { events: [Summary] })

    const handlers = Compacting.toLayer((turn) => {
      expectTypeOf(turn.entries).toEqualTypeOf<Effect.Effect<ReadonlyArray<Assistant.Entry<Summary>>>>()

      const ok = turn.append(Summary.make({ text: "so far" }))

      // @ts-expect-error: Other isn't one of this assistant's events
      const wrong = turn.append(Other.make({ n: 1 }))

      void [ok, wrong]

      return turn.loop({ model: "claude-haiku-4-5", instructions: "Help." })
    })

    expectTypeOf(handlers).toBeObject()
  })
})
