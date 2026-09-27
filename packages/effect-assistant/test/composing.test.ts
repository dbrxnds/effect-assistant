import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Response from "effect/unstable/ai/Response"
import { AssistantEvent, AssistantLoop, ChatView } from "../src/index.ts"
import { Composer, partialText } from "../src/internal/composing.ts"
import { collectUntil, memoryAssistant, newChat, runEntity, say, simple, TestAssistant, turnsDone } from "./fixtures.ts"
import * as Scripted from "./scripted.ts"

const reply = "Your 300 totes ship on Friday, with the logo in navy."

/** The view after these updates. */
const fold = (updates: ReadonlyArray<ChatView.Update>) => updates.reduce(ChatView.apply, ChatView.empty)

/** Every update of a chat's view, from its first turn's end on, until the second turn ends. */
const watch = (text: string) =>
  Effect.gen(function* () {
    const chatId = yield* newChat

    yield* TestAssistant.submit(chatId, say("hi"))
    yield* collectUntil(TestAssistant, chatId, (entries) => turnsDone(entries) >= 1)

    // Sent once the view streams, so it sees the whole second turn.
    const send = yield* Effect.cached(TestAssistant.submit(chatId, say(text)))

    const updates = yield* TestAssistant.subscribeView(chatId).pipe(
      Stream.tap(() => send),
      Stream.scan(
        (): ReadonlyArray<ChatView.Update> => [],
        (all, update) => [...all, update]
      ),
      Stream.takeUntil((all) => {
        const view = fold(all)

        return view.messages.length >= 3 && ChatView.isIdle(view)
      }),
      Stream.runLast,
      Effect.map(Option.getOrElse((): ReadonlyArray<ChatView.Update> => []))
    )

    const log = yield* collectUntil(TestAssistant, chatId, (entries) => turnsDone(entries) >= 2)

    return { updates, log }
  })

const answers = (request: Scripted.Request) =>
  Scripted.lastInput(request) === "hi" ? Scripted.reply("Hi!") : Scripted.reply(reply)

type Engine = (
  handler: Parameters<typeof memoryAssistant>[0],
  model: Layer.Layer<LanguageModel.LanguageModel>
) => ReturnType<typeof memoryAssistant>

const onCluster: Engine = (handler, model) => runEntity(TestAssistant.toLayer(handler), model)

const shows = (engine: string, run: Engine) =>
  it.live(`shows the message as it's written, then the message, and stores none of it (${engine})`, () =>
    Effect.gen(function* () {
      const model = yield* Scripted.make(answers, { pace: "2 millis" })

      const { updates, log } = yield* watch("When do they ship?").pipe(
        Effect.provide(run(simple({ instructions: "Be brief." }), model.layer))
      )

      const written = updates.flatMap((update) =>
        update.activity.composing === undefined ? [] : [update.activity.composing.text]
      )

      expect(written.length).toBeGreaterThan(2)
      expect(written.at(-1)).toBe(reply)
      written.forEach((text, i) => expect(text.startsWith(written[i - 1] ?? "")).toBe(true))

      // The message replaces what was written in one update: the client never shows neither.
      const arrived = updates.find((update) => update.messages.some((message) => message.text === reply))

      expect(arrived?.activity.composing).toBeUndefined()
      expect(fold(updates).activity.composing).toBeUndefined()

      const json = JSON.stringify(updates.map((update) => Schema.encodeSync(ChatView.Update)(update)))

      for (const internal of ["send_user_message", "call_", "wait"]) expect(json).not.toContain(internal)

      expect(log.some(({ event }) => Predicate.isTagged(event, "Composing"))).toBe(false)
    })
  )

describe("composing", () => {
  shows("in memory", memoryAssistant)
  shows("on the cluster", onCluster)

  it.live("stops showing a message the model never finished: its step failed", () =>
    Effect.gen(function* () {
      const parts: ReadonlyArray<Response.StreamPartEncoded> = [
        { type: "response-metadata", id: "response_1", modelId: Scripted.model },
        { type: "tool-params-start", id: "toolu_1", name: "send_user_message" },
        { type: "tool-params-delta", id: "toolu_1", delta: '{"text":"Half a mes' },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }
      ]

      const calls = yield* Ref.make(0)

      // The first turn answers; the second one's model fails mid-message.
      const failing = yield* LanguageModel.make({
        generateText: () => Effect.die("The loop streams."),
        streamText: () =>
          Stream.unwrap(
            Effect.map(
              Ref.getAndUpdate(calls, (n) => n + 1),
              (n) =>
                Scripted.paced(
                  Stream.fromIterable(n === 0 ? Scripted.streamed(Scripted.reply("Hi!")) : parts),
                  "2 millis"
                )
            )
          )
      })

      const layer = Layer.succeed(LanguageModel.LanguageModel, failing)

      const { updates } = yield* watch("When do they ship?").pipe(
        Effect.provide(memoryAssistant(simple({ instructions: "Be brief." }), layer))
      )

      expect(updates.some((update) => update.activity.composing?.text === "Half a mes")).toBe(true)

      const view = fold(updates)

      expect(view.activity.composing).toBeUndefined()
      expect(view.failed).toBe(true)
    })
  )

  it.effect("stops composing when the step is interrupted", () =>
    Effect.gen(function* () {
      const heard = yield* Ref.make<ReadonlyArray<AssistantEvent.Composing>>([])

      const started: ReadonlyArray<Response.StreamPartEncoded> = [
        { type: "tool-params-start", id: "toolu_1", name: "send_user_message" },
        { type: "tool-params-delta", id: "toolu_1", delta: '{"text":"On it' }
      ]

      const hanging = yield* LanguageModel.make({
        generateText: () => Effect.die("The loop streams."),
        streamText: () => Stream.fromIterable(started).pipe(Stream.concat(Stream.never))
      })

      const fiber = yield* AssistantLoop.stream({ instructions: "Be brief.", history: Effect.succeed([]) }).pipe(
        Stream.runDrain,
        Effect.provideService(LanguageModel.LanguageModel, hanging),
        Effect.provideService(Composer, (composing) => Ref.update(heard, (all) => [...all, composing])),
        Effect.forkChild
      )

      yield* Effect.repeat(Ref.get(heard), { until: (all) => all.length >= 2 })
      yield* Fiber.interrupt(fiber)

      expect((yield* Ref.get(heard)).map((composing) => composing.text)).toEqual(["", "On it", undefined])
    })
  )

  it.live("stores the model's output as a whole response has it", () =>
    Effect.gen(function* () {
      const signature = { scripted: { signature: "sig_1" } }

      const model = yield* Scripted.make((request) =>
        Scripted.lastInput(request) === "hi"
          ? [
              { type: "reasoning", text: "They want a greeting back.", metadata: signature },
              Scripted.text("Greeting."),
              { ...Scripted.call("send_user_message", { text: "Hi!", wait: true }), id: "toolu_hi" }
            ]
          : Scripted.reply("Hi!")
      )

      const log = yield* Effect.gen(function* () {
        const chatId = yield* newChat

        yield* TestAssistant.submit(chatId, say("hi"))

        return yield* collectUntil(TestAssistant, chatId, (entries) => turnsDone(entries) >= 1)
      }).pipe(Effect.provide(memoryAssistant(simple({ instructions: "Be brief." }), model.layer)))

      const output = log.flatMap(({ event }) => (Predicate.isTagged(event, "ModelOutput") ? [event] : [])).at(0)

      expect(output?.parts).toEqual([
        Response.makePart("reasoning", { text: "They want a greeting back.", metadata: signature }),
        Response.makePart("text", { text: "Greeting." }),
        Response.makePart("tool-call", {
          id: "toolu_hi",
          name: "send_user_message",
          params: { text: "Hi!", wait: true },
          providerExecuted: false
        })
      ])
      expect(output?.model).toBe(Scripted.model)
      expect(output?.responseId).toBe("response_1")
      expect(output?.usage?.inputTokens).toEqual({ total: 120, uncached: 20, cacheRead: 100, cacheWrite: 0 })
    })
  )
})

describe("partialText", () => {
  it("reads the text param as far as it's written, wherever the JSON stops", () => {
    const json =
      '{"wait":false,"block":{"kind":"note","props":{"text":"not this"}},"text":"Line one\\nsaid \\"hi\\" \\u00e9!"}'

    const cuts = Array.from({ length: json.length + 1 }, (_, n) => partialText(json.slice(0, n)))
    const full = 'Line one\nsaid "hi" é!'

    expect(cuts.at(-1)).toBe(full)
    expect(cuts.filter((text) => text !== undefined).every((text) => full.startsWith(text))).toBe(true)
    expect(cuts.slice(0, json.indexOf('"text":"Line'))).toEqual(
      cuts.slice(0, json.indexOf('"text":"Line')).map(() => undefined)
    )
  })
})
