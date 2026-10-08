/** The `Assistant` module defines assistants: colleagues in a chat. */
import type * as AiError from "effect/ai/AiError"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Prompt from "effect/ai/Prompt"
import * as Effect from "effect/Effect"
import * as Filter from "effect/Filter"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as AppEvent from "./AppEvent.ts"
import type { AssistantChat } from "./AssistantChat.ts"
import { AssistantEngine } from "./AssistantEngine.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import type * as AssistantLoop from "./AssistantLoop.ts"
import type * as BlockKit from "./BlockKit.ts"
import { ChatId } from "./ChatId.ts"
import * as ChatView from "./ChatView.ts"
import type * as Instructions from "./Instructions.ts"
import * as AppEvents from "./internal/events.ts"
import * as Turns from "./internal/turns.ts"
import type { Skill } from "./Skill.ts"
import type * as Specialist from "./Specialist.ts"

/**
 * Services a turn provides to its tools, loop, and specialists: its chat, and
 * the chat's specialist runner.
 */
export type TurnServices = AssistantChat | Specialist.Runner

/** Options for `turn.loop`. */
export interface LoopOptions<RT = never, RS = never, Events = never> {
  /** The assistant's role and rules. `Instructions.protocol` goes before them. */
  readonly instructions: string | Instructions.Resolved
  /**
   * Its tools, next to its own: `AssistantLoop.fromToolkit(toolkit)` of a native toolkit. For tools found on demand, merge
   * in `ToolDiscovery.make(...)`.
   */
  readonly toolkit?: AssistantLoop.Tools<RT> | undefined
  /** Playbooks: a catalog in the prompt, loaded with `load_skill` when a task matches. */
  readonly skills?: ReadonlyArray<Skill<RS>> | undefined
  /** Model calls per turn. Default 16. */
  readonly maxSteps?: number | undefined
  /** What the reply pass tells the model when the turn would end without replying. */
  readonly replyNudge?: string | undefined
  /**
   * Which of the chat's entries the model reads, like the ones since a summary. Default: all of them.
   */
  readonly history?: HistoryView<Events> | undefined
}

/**
 * Which of a chat's entries the model reads, and what else goes with them:
 * returns entries (the model reads them as usual) and prompt messages (it
 * reads them as they are), in order.
 */
export type HistoryView<Events = never> = (
  entries: ReadonlyArray<Entry<Events>>
) => ReadonlyArray<Entry<Events> | Prompt.Message>

/** A chat's entry, with the assistant's own events decoded to their types. */
export interface Entry<Events = never> {
  readonly chatId: ChatId
  readonly seq: number
  readonly at: number
  readonly event: AssistantEvent.AssistantEvent | Events
}

/** Options for `turn.replyIfOwed`. */
export interface ReplyOptions {
  /** The assistant's instructions, as for `turn.loop`: `Instructions.protocol` is added. */
  readonly instructions: string | Instructions.Resolved
  /**
   * What to tell the model, after the history. Default: that it hasn't replied yet, and should now.
   */
  readonly nudge?: string | undefined
}

/**
 * One turn, as the assistant's handler sees it. `Events` are the app's own
 * events the assistant registered (its `events` option).
 */
export interface Turn<Events = never> {
  readonly chatId: ChatId
  /**
   * The model's history, from the chat's entries (all of them, or what a
   * view keeps), with how far into the chat it goes. Read it before every
   * model call; the loop does. A step records how far its model read, and
   * the turn ends having handled what its model saw: an input that arrived
   * after gets the next turn.
   */
  readonly history: (view?: HistoryView<Events>) => Effect.Effect<AssistantLoop.ChatHistory>
  /**
   * The chat's entries, with the assistant's own events decoded. Reading them has no effect on the turn.
   */
  readonly entries: Effect.Effect<ReadonlyArray<Entry<Events>>>
  /**
   * Writes the assistant's own events to the chat, like a summary. One that wakes a turn gets the next turn.
   */
  readonly append: (...events: ReadonlyArray<Events>) => Effect.Effect<void>
  /** The assistant's own tools: `send_user_message`, `wait`, and the specialist tools. */
  readonly tools: AssistantLoop.Tools<TurnServices>
  /**
   * The full system prompt for these instructions: `Instructions.protocol`,
   * the instructions, and the specialist runs working now.
   */
  readonly instructions: (instructions: string | Instructions.Resolved) => Instructions.Resolved
  /**
   * The agent loop over the chat, with `Instructions.protocol`, the assistant's own tools,
   * and these instructions, tools, and skills. Every step is a tool call. It
   * ends with `replyIfOwed`.
   */
  readonly loop: <RT = never, RS = never>(
    options: LoopOptions<RT, RS, Events>
  ) => Stream.Stream<AssistantLoop.Event, AiError.AiError, LanguageModel.LanguageModel | TurnServices | RT | RS>
  /**
   * One more pass, when the turn would end without replying to the user's
   * latest message: the model can then only reply. Empty when no reply is
   * owed, or when an input arrived that the next turn reads. `loop` runs
   * it with its own prompt and tools, so the pass reads the cached prompt.
   */
  readonly replyIfOwed: (
    options: ReplyOptions
  ) => Stream.Stream<AssistantLoop.Event, AiError.AiError, LanguageModel.LanguageModel | TurnServices>
}

/**
 * An assistant's handler: runs a turn, as a stream of what the loop did. It
 * may return the stream from an Effect. `R` is what the stream needs, `RE`
 * what the Effect needs.
 */
export type Handler<R = never, RE = R, Events = never> = (
  turn: Turn<Events>
) =>
  | Stream.Stream<AssistantLoop.Event, unknown, R>
  | Effect.Effect<Stream.Stream<AssistantLoop.Event, unknown, R>, unknown, RE>

/**
 * Returns what an assistant's handler needs beyond what its turns provide
 * (the turn services and `LanguageModel`): what its build Effect must
 * require.
 */
export type HandlerServices<R> = Exclude<R, TurnServices | LanguageModel.LanguageModel>

/** A handler's result as a stream: it may return the stream from an Effect. */
const toStream = <R, RE>(
  result:
    | Stream.Stream<AssistantLoop.Event, unknown, R>
    | Effect.Effect<Stream.Stream<AssistantLoop.Event, unknown, R>, unknown, RE>
): Stream.Stream<AssistantLoop.Event, unknown, R | RE> => (Effect.isEffect(result) ? Stream.unwrap(result) : result)

/**
 * An assistant's definition: what callers and the UI need to know, and its
 * handler's layer, which registers it with the engine. `Events` are the
 * app's own events it registered.
 */
export interface Assistant<Name extends string = string, Specs extends Specialist.Any = never, Events = never> {
  readonly name: Name
  readonly blocks: BlockKit.BlockKit | undefined
  /** The specialists it can hand work to. */
  readonly specialists: ReadonlyArray<Specs>
  /** The app's own events it registered. */
  readonly events: ReadonlyArray<AppEvent.Any>
  /**
   * Registers the assistant's handler with the engine. The handler may use
   * the turn services, `LanguageModel`, and services its build Effect
   * required (see `Specialist.CheckServices`). The layer needs the model API
   * and each specialist's handler (`Research.toLayer(...)`).
   */
  readonly toLayer: <R = never, RE = never, E = never, RX = never>(
    build: (Handler<R, RE, Events> | Effect.Effect<Handler<R, RE, Events>, E, RX>) &
      Specialist.CheckServices<Exclude<HandlerServices<R | RE>, RX>>
  ) => Layer.Layer<
    never,
    never,
    | AssistantEngine
    | LanguageModel.LanguageModel
    | Specialist.HandlerOf<Specs>
    | Exclude<RX, Scope.Scope | AssistantChat>
  >
  /**
   * Stores an input or one of the assistant's own events, and returns: a
   * user's message or block answer, a workflow's progress, the draft the
   * user opened. The assistant works on what wakes a turn in the background.
   */
  readonly submit: (chatId: ChatId, input: AssistantEvent.Input | Events) => Effect.Effect<void, never, AssistantEngine>
  /**
   * Streams the chat's whole log (the entries after `after`, for a reader
   * that has the rest), then live ones, with the assistant's own events
   * decoded.
   */
  readonly subscribe: (
    chatId: ChatId,
    options?: { readonly after?: number | undefined }
  ) => Stream.Stream<Entry<Events>, never, AssistantEngine>
  /**
   * Streams the chat as its user sees it, for a chat client: what changed in
   * its messages, blocks, and activity (see `ChatView`), from the start, then
   * live. A client that has the view up to a `seq` passes it as `after`, and
   * gets only what changed since.
   */
  readonly subscribeView: (
    chatId: ChatId,
    options?: { readonly after?: number | undefined }
  ) => Stream.Stream<ChatView.Update, never, AssistantEngine>
  /**
   * Deletes a chat: its log, and what works in it. A turn or specialist run
   * working in it stops, subscribers' streams end, and the chat stores
   * nothing again: a later `submit`, a run's report, or a workflow's event
   * for it is dropped, quietly. A workflow waiting on one of its decisions
   * gets `"declined"`, since no one can answer it now. Deleting it again
   * does nothing.
   */
  readonly delete: (chatId: ChatId) => Effect.Effect<void, never, AssistantEngine>
  /** Schema for the chat's entries, the assistant's own events included, in JSON. */
  readonly Entry: Schema.Codec<Entry<Events>, Schema.Json>
}

/** Any assistant. */
export type Any = Assistant<any, any, any>

/** The entry schema for these app events, in JSON: the library's events, and the app's. */
function entrySchema<E>(events: ReadonlyArray<AppEvent.Any>): Schema.Codec<Entry<E>, Schema.Json>
// The overload states the decoded type: the library's events, or one of these schemas' types.
function entrySchema(events: ReadonlyArray<AppEvent.Any>): Schema.Top {
  return Schema.toCodecJson(
    Schema.Struct({
      chatId: ChatId,
      seq: Schema.Int,
      at: Schema.Finite,
      event: Schema.Union([AssistantEvent.AssistantEvent, ...events.map((event) => event.schema)])
    })
  )
}

const isLibraryInput = (input: { readonly _tag: string }): input is AssistantEvent.Input =>
  AssistantEvent.isInput(input) ||
  (AssistantEvent.isLibraryEvent(input) && Predicate.isTagged(input, "DecisionRequested"))

/**
 * Defines an assistant: its name, its UI blocks, its specialists, and the
 * app's own events it stores (see `AppEvent`).
 */
export const make = <
  const Name extends string,
  const Specs extends ReadonlyArray<Specialist.Any> = readonly [],
  const Events extends ReadonlyArray<AppEvent.Any> = readonly []
>(
  name: Name,
  options?: {
    /** UI blocks the assistant can add to its messages. */
    readonly blocks?: BlockKit.BlockKit | undefined
    /**
     * The specialists it can hand work to; each needs its `toLayer` provided to the assistant's.
     */
    readonly specialists?: Specs | undefined
    /**
     * The app's own events: `AppEvent.make(schema, { wakes, render })` for
     * each. `submit` and `turn.append` store them, and `turn.entries` reads
     * them back, typed. Those that wake a turn are inputs, and the model
     * reads each one it has a `render` for.
     */
    readonly events?: Events | undefined
  }
): Assistant<Name, Specs[number], AppEvent.Type<Events[number]>> => {
  const events = options?.events ?? []

  const definition: Turns.Definition = {
    name,
    blocks: options?.blocks,
    specialists: options?.specialists ?? [],
    app: AppEvents.make(events)
  }

  // The signature checks what the handler uses (`CheckServices`); the layer's services, which the build
  // required, are provided to it and to every turn's stream, so what's left is the turn services.
  function toLayer<R = never, RE = never, E = never, RX = never>(
    build: (
      | Handler<R, RE, AppEvent.Type<Events[number]>>
      | Effect.Effect<Handler<R, RE, AppEvent.Type<Events[number]>>, E, RX>
    ) &
      Specialist.CheckServices<Exclude<HandlerServices<R | RE>, RX>>
  ): Layer.Layer<
    never,
    never,
    | AssistantEngine
    | LanguageModel.LanguageModel
    | Specialist.HandlerOf<Specs[number]>
    | Exclude<RX, Scope.Scope | AssistantChat>
  >
  function toLayer(
    build: Handler<any, any, any> | Effect.Effect<Handler<any, any, any>, unknown, any>
  ): Layer.Layer<never, never, any> {
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const context = yield* Effect.context()

        const registration = yield* Turns.register(definition, {
          // The build runs per chat activation, in the chat; here it only keeps the layer's services for it.
          open: Effect.gen(function* () {
            const handler = Effect.isEffect(build) ? yield* build : build

            return (turn: Turn<any>) => Stream.provideContext(toStream(handler(turn)), context)
          }).pipe(Effect.provideContext(context), Effect.orDie)
        })

        yield* (yield* AssistantEngine).register(registration)
      })
    )
  }

  // The app's own events go to the engine as they're stored; the library's as they are (a parked call too: the
  // chat refuses it).
  const stored = (
    input: AssistantEvent.Input | AppEvent.Type<Events[number]>
  ): Effect.Effect<AssistantEvent.Input | AssistantEvent.StoredAppEvent> =>
    isLibraryInput(input) ? Effect.succeed(input) : AppEvents.encode(definition.app, input)

  const assistant: Assistant<Name, Specs[number], AppEvent.Type<Events[number]>> = {
    name,
    blocks: options?.blocks,
    specialists: options?.specialists ?? [],
    events,
    toLayer,
    submit: Effect.fn("Assistant.submit")(function* (
      chatId: ChatId,
      input: AssistantEvent.Input | AppEvent.Type<Events[number]>
    ) {
      const event = yield* stored(input)

      yield* AssistantEngine.use((engine) => engine.submit(name, chatId, event))
    }),
    subscribe: (chatId, options) =>
      Stream.unwrap(AssistantEngine.useSync((engine) => engine.subscribe(name, chatId, options?.after ?? 0))).pipe(
        Stream.filterMap(
          Filter.fromPredicateOption((entry: AssistantEvent.Entry) => AppEvents.decodeEntry(definition.app, entry))
        )
      ),
    delete: (chatId) => AssistantEngine.use((engine) => engine.delete(name, chatId)),
    subscribeView: (chatId, options) =>
      ChatView.updates(Stream.unwrap(AssistantEngine.useSync((engine) => engine.subscribe(name, chatId, 0))), {
        wakes: definition.app.wakes,
        after: options?.after
      }),
    Entry: entrySchema(events)
  }

  return assistant
}
