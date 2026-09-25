/**
 * What the tests share. Most tests run on a scripted model (`scripted.ts`);
 * `realModel` is the Anthropic API, for the contract tests. It needs
 * ANTHROPIC_API_KEY (loaded from .env.local).
 */
import * as Anthropic from "@effect-uai/anthropic/Anthropic"
import type * as LanguageModel from "@effect-uai/core/LanguageModel"
import type * as Toolkit from "@effect-uai/core/Toolkit"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import * as TestRunner from "effect/unstable/cluster/TestRunner"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import {
  Assistant,
  AssistantActivity,
  AssistantEngine,
  AssistantEvent,
  ChatId,
  ChatLog,
  InputId
} from "../src/index.ts"

/** The Anthropic API, for the contract tests. */
export const realModel = Anthropic.layer({
  apiKey: Redacted.make(process.env.ANTHROPIC_API_KEY ?? "")
}).pipe(Layer.provide(FetchHttpClient.layer))

/** A small, fast model: the contract tests check behaviour, not wording. */
export const testModel = "claude-haiku-4-5"

/** The assistant most tests use: no blocks, no specialists. */
export const TestAssistant = Assistant.make("test")

/** The event log, in memory. */
export const layerStorage = ChatLog.layerMemory

type Model = Layer.Layer<LanguageModel.LanguageModel>

/** Runs these assistants' handlers on the in-memory engine, with their own storage and this model. */
export const runMemory = <E, RIn>(handlers: Layer.Layer<never, E, RIn>, model: Model) =>
  handlers.pipe(Layer.provideMerge(AssistantEngine.layerMemory), Layer.provideMerge(layerStorage), Layer.provide(model))

/** Runs these assistants' handlers on the cluster engine, on the in-process cluster. */
export const runEntity = <E, RIn>(handlers: Layer.Layer<never, E, RIn>, model: Model) =>
  handlers.pipe(
    Layer.provideMerge(AssistantEngine.layerCluster),
    Layer.provideMerge(layerStorage),
    Layer.provide(model),
    Layer.provideMerge(TestRunner.layer)
  )

/** A handler that runs the turn's loop with these options. */
export const simple =
  <Tools extends Toolkit.Toolkit = Record<never, never>, R = never>(
    options: Omit<Assistant.LoopOptions<Tools, R>, "model">
  ) =>
  (turn: Assistant.Turn) =>
    turn.loop({ model: testModel, ...options })

/** An in-memory `TestAssistant` with this handler, its own event log, and this model. */
export const memoryAssistant = (
  handler: Assistant.Handler<Assistant.TurnServices | LanguageModel.LanguageModel>,
  model: Model
) => runMemory(TestAssistant.toLayer(handler), model)

/** A new chat's id. */
export const newChat = ChatId.make

/** A new input id, for events built outside an Effect. */
const inputId = () => Effect.runSync(InputId.make)

export const say = (text: string) => AssistantEvent.UserMessage.make({ id: inputId(), text })

export const fact = (source: string, payload: Record<string, string | number>) =>
  AssistantEvent.Fact.make({ id: inputId(), source, payload })

/** One line per entry, for a failure message. */
export const traceEntries = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries
    .map(({ seq, event }) => {
      const detail =
        Predicate.isTagged(event, "UserMessage") || Predicate.isTagged(event, "AssistantMessage")
          ? event.text
          : Predicate.isTagged(event, "ModelOutput")
            ? event.items.flatMap((item) => (item.type === "function_call" ? [item.name] : [])).join(",")
            : Predicate.isTagged(event, "ToolResult")
              ? `${event.tool}: ${event.output.slice(0, 80)}`
              : Predicate.isTagged(event, "Fact")
                ? JSON.stringify(event.payload).slice(0, 120)
                : ""

      return `${seq} ${event._tag} ${detail}`
    })
    .join("\n")

/** Collects a chat's events until `until` holds for them, or fails after `timeout` with what it saw. */
export const collectUntil = (
  assistant: Pick<Assistant.Any, "subscribe">,
  chatId: ChatId.ChatId,
  until: (entries: ReadonlyArray<AssistantEvent.Entry>) => boolean,
  timeout = "90 seconds" as const
) =>
  Effect.gen(function* () {
    let seen: ReadonlyArray<AssistantEvent.Entry> = []

    return yield* assistant.subscribe(chatId).pipe(
      Stream.scan(
        (): ReadonlyArray<AssistantEvent.Entry> => [],
        (acc, entry) => [...acc, entry]
      ),
      Stream.tap((entries) => Effect.sync(() => (seen = entries))),
      Stream.takeUntil(until),
      Stream.runLast,
      Effect.map(Option.getOrElse((): ReadonlyArray<AssistantEvent.Entry> => [])),
      Effect.timeout(timeout),
      Effect.catchTag("TimeoutError", () => Effect.die(new Error(`timed out; the chat so far:\n${traceEntries(seen)}`)))
    )
  })

/** Completed or failed turns so far. */
export const turnsDone = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.filter(({ event }) => AssistantEvent.isTurnEnd(event)).length

export const failures = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.flatMap(({ event }) => (Predicate.isTagged(event, "TurnFailed") ? [event.message] : []))

/** The names of the tools that ran, in order. */
export const toolsRun = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.flatMap(({ event }) => (Predicate.isTagged(event, "ToolResult") ? [event.tool] : []))

/** The specialist runs' reports, in order. */
export const finished = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.flatMap(({ event }) => (Predicate.isTagged(event, "SpecialistFinished") ? [event] : []))

export const facts = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.flatMap(({ event }) => (Predicate.isTagged(event, "Fact") ? [event] : []))

/** Whether the last entry ends a turn: the assistant is idle. */
export const idle = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.at(-1) !== undefined && Predicate.isTagged(entries.at(-1)!.event, "TurnCompleted")

/** Whether no turn and no specialist run is working. */
export const notWorking = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.length > 0 && !AssistantActivity.isWorking(AssistantActivity.fromEntries(entries))

export const text = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  AssistantEvent.assistantTexts(entries).join(" ").toLowerCase()
