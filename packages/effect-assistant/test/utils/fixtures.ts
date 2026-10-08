/** What the tests share: they run on a scripted model (`scripted.ts`). */
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import * as TestRunner from "effect/cluster/TestRunner"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  AppEvent,
  Assistant,
  AssistantActivity,
  AssistantEngine,
  AssistantEvent,
  ChatId,
  ChatLog,
  ChatView,
  InputId
} from "../../src/index.ts"
import { toJsonText } from "../../src/internal/schema.ts"

/** What a workflow or a webhook reports in the tests: an app event that wakes a turn. */
export class Update extends Schema.TaggedClass<Update>()("Update", {
  id: InputId.InputId,
  source: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite]))
}) {}

/** How the model reads an update. */
export const updateText = (update: Update) =>
  `<update source="${update.source}">\nThe user hasn't seen it: tell them if it matters to them.\n${toJsonText(update.payload)}\n</update>`

export const UpdateEvent = AppEvent.make(Update, { wakes: true, render: updateText })

/** The assistant most tests use: no blocks, no specialists, no events of its own. */
export const TestAssistant = Assistant.make("test")

/** Like `TestAssistant`, with updates: what background work reports. */
export const Updating = Assistant.make("updating", { events: [UpdateEvent] })

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
/** A native toolkit with its handlers, for a test's loop: `simple` provides them. */
export interface WithHandlers<T extends Record<string, Tool.Any>> {
  readonly toolkit: Toolkit.Toolkit<T>
  readonly handlers: Toolkit.HandlersFrom<T>
}

export const withHandlers = <T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<T>,
  handlers: Toolkit.HandlersFrom<T>
): WithHandlers<T> => ({ toolkit, handlers })

/** A handler that runs `turn.loop` with these options. */
export const simple =
  <RS = never>(options: Assistant.LoopOptions<Record<never, never>, RS>) =>
  (turn: Assistant.Turn) =>
    turn.loop(options)

/** A handler that runs `turn.loop` with a toolkit, its handlers provided. */
export const withTools =
  <T extends Record<string, Tool.Any>, RS = never>(
    options: Omit<Assistant.LoopOptions<T, RS>, "toolkit"> & { readonly toolkit: WithHandlers<T> }
  ) =>
  (turn: Assistant.Turn) => {
    const { toolkit, ...rest } = options

    return Stream.unwrap(
      Effect.map(toolkit.toolkit.toHandlers(toolkit.handlers), (handlers) =>
        turn.loop({ ...rest, toolkit: toolkit.toolkit }).pipe(Stream.provideContext(handlers))
      )
    )
  }

/** An in-memory `TestAssistant` with this handler, its own event log, and this model. */
export const memoryAssistant = (
  handler: Assistant.Handler<Assistant.TurnServices | LanguageModel.LanguageModel>,
  model: Model
) => runMemory(TestAssistant.toLayer(handler), model)

/** An in-memory `Updating` assistant with this handler, its own event log, and this model. */
export const updatingAssistant = (
  handler: Assistant.Handler<
    Assistant.TurnServices | LanguageModel.LanguageModel,
    Assistant.TurnServices | LanguageModel.LanguageModel,
    Update
  >,
  model: Model
) => runMemory(Updating.toLayer(handler), model)

/** A new chat's id. */
export const newChat = ChatId.make

/** A new input id, for events built outside an Effect. */
const inputId = () => Effect.runSync(InputId.make)

export const say = (text: string) => AssistantEvent.UserMessage.make({ id: inputId(), text })

export const update = (source: string, payload: Record<string, string | number>) =>
  Update.make({ id: inputId(), source, payload })

/** An update as it's stored, for a test that writes the chat itself. */
export const storedUpdate = (source: string, payload: Record<string, string | number>) =>
  Schema.decodeUnknownSync(AssistantEvent.StoredAppEvent)(
    Schema.encodeSync(Schema.toCodecJson(Update))(update(source, payload))
  )

/** One line per entry, for a failure message. */
export const traceEntries = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries
    .map(({ seq, event }) => {
      const detail =
        Predicate.isTagged(event, "UserMessage") || Predicate.isTagged(event, "AssistantMessage")
          ? event.text
          : Predicate.isTagged(event, "ModelOutput")
            ? event.parts.flatMap((part) => (part.type === "tool-call" ? [part.name] : [])).join(",")
            : Predicate.isTagged(event, "ToolResult")
              ? `${event.tool}: ${toJsonText(event.result).slice(0, 80)}`
              : AssistantEvent.isLibraryEvent(event)
                ? ""
                : toJsonText(event).slice(0, 120)

      return `${seq} ${event._tag} ${detail}`
    })
    .join("\n")

/** Collects a chat's events until `until` holds for them, or fails after `timeout` with what it saw. */
export const collectUntil = (
  assistant: Pick<Assistant.Any, "subscribe">,
  chatId: ChatId.ChatId,
  until: (entries: ReadonlyArray<AssistantEvent.Entry>) => boolean,
  timeout: Duration.Input = "90 seconds"
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

export const updates = (entries: ReadonlyArray<Assistant.Entry<Update>>) =>
  entries.flatMap(({ event }) => (event instanceof Update ? [event] : []))

/** Whether the last entry ends a turn: the assistant is idle. */
export const idle = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.at(-1) !== undefined && Predicate.isTagged(entries.at(-1)!.event, "TurnCompleted")

/** Whether no turn and no specialist run is working. */
export const notWorking = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.length > 0 && !AssistantActivity.isWorking(AssistantActivity.fromEntries(entries))

export const text = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  AssistantEvent.assistantTexts(entries).join(" ").toLowerCase()

/** The assistant's messages in a chat's view, as a client gets them. */
export const viewedMessages = (entries: ReadonlyArray<AssistantEvent.AnyEntry>) =>
  ChatView.fromEntries(entries).messages.flatMap((message) =>
    Predicate.isTagged(message, "AssistantMessage") ? [message] : []
  )
