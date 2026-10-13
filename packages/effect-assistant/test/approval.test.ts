/**
 * Tools with Effect's `needsApproval`: the library doesn't run calls that wait
 * for approval, so every loop refuses them before the model is called, and so
 * does a `ToolDiscovery` catalog when its layer is built.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { Assistant, AssistantLoop, Specialist, ToolDiscovery } from "../src/index.ts"
import {
  collectUntil,
  failures,
  finished,
  newChat,
  notWorking,
  runMemory,
  say,
  simple,
  text,
  withHandlers,
  withTools
} from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const instructions = "You help a small team."

const PlaceOrder = Tool.make("place_order", {
  description: "Places an order.",
  parameters: Schema.Struct({ sku: Schema.String, quantity: Schema.Int }),
  success: Schema.Struct({ reference: Schema.String }),
  needsApproval: true
})

/** `place_order`, counting its runs. */
const orderTools = Effect.gen(function* () {
  const runs = yield* Ref.make(0)

  const toolkit = withHandlers(Toolkit.make(PlaceOrder), {
    place_order: () => Ref.update(runs, (n) => n + 1).pipe(Effect.as({ reference: "R-1" }))
  })

  return { runs: Ref.get(runs), toolkit }
})

const refusal = "place_order sets needsApproval"

describe("a tool with needsApproval", () => {
  it.live("fails a turn's loop before the model is called", () =>
    Effect.gen(function* () {
      const { runs, toolkit } = yield* orderTools
      const Ordering = Assistant.make("approval-turn")

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Ordering).submit(chat, say("Order 300 totes."))

        return yield* collectUntil(Ordering, chat, (es) => failures(es).length > 0, "10 seconds")
      }).pipe(Effect.provide(runMemory(Ordering.toLayer(withTools({ instructions, toolkit })), Scripted.unused)))

      expect(failures(entries)[0]).toContain(refusal)
      expect(failures(entries)[0]).toContain("Block.answer")
      expect(yield* runs).toBe(0)
    })
  )

  it.live("fails a loop of your own too", () =>
    Effect.gen(function* () {
      const { runs, toolkit } = yield* orderTools
      const Own = Assistant.make("approval-own-loop")

      const handlers = Own.toLayer((turn) =>
        AssistantLoop.run({
          instructions: turn.instructions(instructions),
          toolkit: toolkit.toolkit,
          history: turn.history()
        })
      ).pipe(Layer.provide(toolkit.toolkit.toLayer(toolkit.handlers)))

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Own).submit(chat, say("Order 300 totes."))

        return yield* collectUntil(Own, chat, (es) => failures(es).length > 0, "10 seconds")
      }).pipe(Effect.provide(runMemory(handlers, Scripted.unused)))

      expect(failures(entries)[0]).toContain(refusal)
      expect(yield* runs).toBe(0)
    })
  )

  it.live("fails a specialist's run, which reports back as failed", () =>
    Effect.gen(function* () {
      const { runs, toolkit } = yield* orderTools
      const Buyer = Specialist.make("buyer", { description: "Buys things." })
      const WithBuyer = Assistant.make("approval-specialist", { specialists: [Buyer] })

      const handlers = WithBuyer.toLayer(simple({ instructions })).pipe(
        Layer.provide(
          Buyer.toLayer((run) => run.loop({ instructions: "Buy it.", toolkit: toolkit.toolkit })).pipe(
            Layer.provide(toolkit.toolkit.toLayer(toolkit.handlers))
          )
        )
      )

      // The run never calls the model: only the assistant's turns do.
      const script: Scripted.Script = (request) => {
        const last = Scripted.lastInput(request)

        if (last.includes("<specialist")) return Scripted.reply(last.includes("needsApproval") ? "It failed." : "Hm.")

        return Scripted.hasCalled(request, "spawn_specialist")
          ? Scripted.wait()
          : [Scripted.call("spawn_specialist", { specialist: "buyer", goal: "Buy 300 totes." })]
      }

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* WithBuyer).submit(chat, say("Have the buyer order 300 totes."))

        return yield* collectUntil(WithBuyer, chat, (es) => text(es).includes("failed") && notWorking(es), "10 seconds")
      }).pipe(Effect.provide(runMemory(handlers, Scripted.layer(script))))

      expect(finished(entries).map((run) => run.status)).toEqual(["failed"])
      expect(finished(entries)[0]?.error).toContain(refusal)
      expect(yield* runs).toBe(0)
    })
  )

  it.effect("fails a ToolDiscovery layer over a catalog that has one", () =>
    Effect.gen(function* () {
      const { toolkit } = yield* orderTools

      const exit = yield* Layer.build(
        ToolDiscovery.layer(toolkit.toolkit).pipe(Layer.provide(toolkit.toolkit.toLayer(toolkit.handlers)))
      ).pipe(Effect.scoped, Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(refusal)
    })
  )
})
