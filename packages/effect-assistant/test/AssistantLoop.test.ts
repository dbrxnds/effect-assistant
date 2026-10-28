import { describe, expect, it } from "@effect/vitest"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as ErrorReporter from "effect/ErrorReporter"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Tracer from "effect/Tracer"
import { Assistant, AssistantLoop } from "../src/index.ts"
import { collectUntil, failures, newChat, runMemory, say, toolsRun, turnsDone } from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const Lookup = Tool.make("lookup", {
  description: "Looks a thing up.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String
})

const LookupTools = Toolkit.make(Lookup)

const LookupToolsLive = LookupTools.toLayer({ lookup: ({ id }) => Effect.succeed(`found ${id}`) })

const Own = Assistant.make("own-loop-tools")

describe("AssistantLoop.run in a turn", () => {
  it.live("runs the app's native toolkit, with the assistant's own tools next to it", () =>
    Effect.gen(function* () {
      const model = Scripted.layer((request) =>
        Scripted.hasCalled(request, "lookup") ? Scripted.reply("Found it.") : [Scripted.call("lookup", { id: "7" })]
      )

      // The handlers come from the layer; leaving out LookupToolsLive is a type error.
      const handlers = Own.toLayer((turn) =>
        AssistantLoop.run({
          instructions: turn.instructions("Be brief."),
          toolkit: LookupTools,
          history: turn.history()
        }).pipe(Stream.concat(turn.replyIfOwed({ instructions: "Be brief." })))
      ).pipe(Layer.provide(LookupToolsLive))

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Own).submit(chat, say("Look up 7."))

        return yield* collectUntil(Own, chat, (es) => turnsDone(es) >= 1, "10 seconds")
      }).pipe(Effect.provide(runMemory(handlers, model)))

      // The app's tool ran, and send_user_message, the assistant's own, too.
      expect(toolsRun(entries)).toEqual(["lookup", "send_user_message"])
    })
  )
})

describe("AssistantLoop.run with a call it can't run", () => {
  it.live("a call to a tool the turn doesn't offer goes back to the model as a failed result", () =>
    Effect.gen(function* () {
      // A tool from earlier in the chat that this turn no longer offers.
      const model = Scripted.layer((request) =>
        Option.match(Scripted.result(request, "archive_note"), {
          onNone: () => [Scripted.call("archive_note", { id: "7" })],
          onSome: (result) => Scripted.reply(result)
        })
      )

      const handlers = Own.toLayer((turn) =>
        AssistantLoop.run({
          instructions: turn.instructions("Be brief."),
          toolkit: LookupTools,
          history: turn.history()
        })
      ).pipe(Layer.provide(LookupToolsLive))

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Own).submit(chat, say("Archive note 7."))

        return yield* collectUntil(Own, chat, (es) => turnsDone(es) >= 1, "10 seconds")
      }).pipe(Effect.provide(runMemory(handlers, model)))

      expect(failures(entries)).toEqual([])
      expect(toolsRun(entries)).toEqual(["archive_note", "send_user_message"])
      expect(
        entries.flatMap(({ event }) => (Predicate.isTagged(event, "AssistantMessage") ? [event.text] : []))
      ).toEqual([expect.stringContaining("No tool named archive_note")])
    })
  )
})

describe("A failed turn", () => {
  it.live("is reported to the ErrorReporter, besides the chat", () =>
    Effect.gen(function* () {
      const reported: Array<string> = []

      const reporter = ErrorReporter.make(({ error }) => {
        reported.push(error.message)
      })

      const handlers = Own.toLayer(() => Stream.die(new Error("the model is down")))

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Own).submit(chat, say("Hi."))

        return yield* collectUntil(Own, chat, (es) => turnsDone(es) >= 1, "10 seconds")
      }).pipe(Effect.provide(runMemory(handlers, Scripted.unused)), Effect.provide(ErrorReporter.layer([reporter])))

      expect(failures(entries)).toHaveLength(1)
      expect(reported).toEqual(["the model is down"])
    })
  )
})

describe("AssistantLoop.run's trace", () => {
  it.live("traces each model call once, on Effect's own span, with the prompt and completion", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = []

      const recording = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)

          return span
        }
      })

      const model = Scripted.layer(() => Scripted.reply("Hello."))

      const handlers = Own.toLayer((turn) =>
        AssistantLoop.run({
          instructions: turn.instructions({ text: "Be brief.", attributes: { "prompt.name": "brief" } }),
          toolkit: LookupTools,
          history: turn.history()
        })
      ).pipe(Layer.provide(LookupToolsLive))

      yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* Own).submit(chat, say("Hi."))

        return yield* collectUntil(Own, chat, (es) => turnsDone(es) >= 1, "10 seconds")
      }).pipe(Effect.provide(runMemory(handlers, model)), Effect.withTracer(recording))

      const modelCalls = spans.filter((span) => span.name === "LanguageModel.generateText")

      expect(spans.filter((span) => span.name.startsWith("chat"))).toEqual([])
      expect(modelCalls.length).toBeGreaterThan(0)

      for (const span of modelCalls) {
        expect(span.attributes.get("gen_ai.prompt")).toContain("Be brief.")
        expect(span.attributes.get("gen_ai.completion")).toContain("Hello.")
        expect(span.attributes.get("prompt.name")).toBe("brief")
      }
    })
  )
})
