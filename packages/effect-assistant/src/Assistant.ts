/**
 * This module provides `Assistant.make`, which defines an assistant that works in a chat the way a
 * colleague does: the user messages it, it works in the background with the app's tools, and it
 * messages the user back.
 *
 * A definition is what the rest of an app imports. Yielding it (`yield* MyAssistant`) returns the
 * assistant's {@link Service}, which submits inputs to chats and streams them back. Its `toLayer`
 * registers the handler that runs each {@link Turn} with the `AssistantEngine`, and its
 * `layerClient` provides the service without a handler. Code that runs inside a chat reads and
 * extends that chat through the definition's {@link Chat} key.
 *
 * @since 0.1.0
 */
import type * as AiError from "effect/ai/AiError"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Prompt from "effect/ai/Prompt"
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Filter from "effect/Filter"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { AssistantEngine } from "./AssistantEngine.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import type * as AssistantLoop from "./AssistantLoop.ts"
import type * as BlockKit from "./BlockKit.ts"
import { ChatId } from "./ChatId.ts"
import * as Chats from "./Chats.ts"
import type { CurrentChat } from "./CurrentChat.ts"
import type * as Instructions from "./Instructions.ts"
import * as AppEvents from "./internal/events.ts"
import * as Turns from "./internal/turns.ts"
import type { Skill } from "./Skill.ts"
import type * as Specialist from "./Specialist.ts"

const TypeId = "~effect-assistant/Assistant" as const

/**
 * Represents the services that a turn provides to its tools, its loop, and its specialists. These
 * are the turn's chat (`CurrentChat`) and the chat's specialist runner (`Specialist.Runner`).
 *
 * @category utility types
 * @since 0.1.0
 */
export type TurnServices = CurrentChat | Specialist.Runner

/**
 * Represents the options accepted by `turn.loop`.
 *
 * @category models
 * @since 0.1.0
 */
export interface LoopOptions<T extends Record<string, Tool.Any> = Record<never, never>, RS = never, Events = never> {
  /** The assistant's role and rules. The loop places `Instructions.protocol` before them. */
  readonly instructions: string | Instructions.Resolved
  /**
   * Tools the model can use in addition to the assistant's own. This is an `effect/ai` toolkit,
   * and its handlers come from the layer. Combine several toolkits with `Toolkit.merge`, for
   * example `Memory.Tools` or a `ToolDiscovery.make(...)` toolkit together with your own.
   */
  readonly toolkit?: Toolkit.Toolkit<T> | undefined
  /**
   * Playbooks the model can follow. The prompt lists them as a catalog, and the model loads one
   * with `load_skill` when a task matches it. A skill made with `tools` is left out when the turn's
   * tools lack one of them.
   */
  readonly skills?: ReadonlyArray<Skill<RS>> | undefined
  /** The maximum number of model calls per turn. Defaults to 16. */
  readonly maxSteps?: number | undefined
  /** The message the reply pass gives the model when the turn would end without a reply. */
  readonly replyNudge?: string | undefined
  /**
   * Selects which of the chat's entries the model reads, for example only those since the last
   * summary, and maps the app's own events it should read into prompt messages. Defaults to all
   * entries, without the app's events.
   */
  readonly history?: HistoryView<Events> | undefined
}

/**
 * Represents a function that selects which of a chat's entries the model reads, and what else it
 * reads with them.
 *
 * **Details**
 *
 * The function receives the chat's entries, the app's own events among them, and returns, in
 * order, a mix of entries and `Prompt.Message`s. The model reads the returned entries the same way
 * it reads the full history, and reads each prompt message unchanged, where the view put it. The
 * model reads none of the app's events by itself: map those it should read to a message, and an
 * app event's entry left in the result is dropped.
 *
 * A message stands right after the entry before it: one that came after the model's last read, or
 * between a tool call and its result, moves after them, as an input does.
 *
 * **Example** (Telling the model about an order the user placed)
 *
 * ```ts
 * import { Assistant, InputId } from "effect-assistant"
 * import * as Prompt from "effect/ai/Prompt"
 * import * as Schema from "effect/Schema"
 *
 * class OrderPlaced extends Schema.TaggedClass<OrderPlaced>()("OrderPlaced", {
 *   id: InputId.InputId,
 *   reference: Schema.String
 * }) {}
 *
 * const MyAssistant = Assistant.make("my-assistant", { events: [OrderPlaced] })
 *
 * const withOrders: Assistant.HistoryView<OrderPlaced> = (entries) =>
 *   entries.map((entry) =>
 *     entry.event instanceof OrderPlaced
 *       ? Prompt.userMessage({
 *           content: [Prompt.textPart({ text: `The user placed order ${entry.event.reference}.` })]
 *         })
 *       : entry
 *   )
 *
 * // An `OrderPlaced` that the API submits wakes a turn, which reads it as this note.
 * const MyAssistantLive = MyAssistant.toLayer((turn) =>
 *   turn.loop({ instructions: "Be brief.", history: withOrders })
 * )
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export type HistoryView<Events = never> = (
  entries: ReadonlyArray<Entry<Events>>
) => ReadonlyArray<Entry<Events> | Prompt.Message>

/**
 * Represents an entry in a chat's log, with the assistant's own events decoded to their types.
 *
 * @category models
 * @since 0.1.0
 */
export interface Entry<Events = never> {
  readonly chatId: ChatId
  readonly seq: number
  readonly at: number
  readonly event: AssistantEvent.AssistantEvent | Events
}

/**
 * Represents the options accepted by `turn.replyIfOwed`.
 *
 * @category models
 * @since 0.1.0
 */
export interface ReplyOptions {
  /** The assistant's instructions, as passed to `turn.loop`. `Instructions.protocol` is added. */
  readonly instructions: string | Instructions.Resolved
  /**
   * The message given to the model after the history. Defaults to a message saying that it
   * hasn't replied yet and should reply now.
   */
  readonly nudge?: string | undefined
}

/**
 * Represents one turn, as the assistant's handler receives it.
 *
 * `Events` is the type of the app's own events that the assistant registered with its `events`
 * option.
 *
 * @category models
 * @since 0.1.0
 */
export interface Turn<Events = never> {
  readonly chatId: ChatId
  /**
   * Returns the model's history, built from the chat's entries (all of them, or those a view
   * keeps), together with how far into the chat it reaches.
   *
   * Read it before every model call, as the loop does. Each step records how far its model call
   * read, and the turn ends once it has handled what the model saw. An input that arrived after
   * that is handled by the next turn.
   */
  readonly history: (view?: HistoryView<Events>) => Effect.Effect<AssistantLoop.ChatHistory>
  /**
   * Returns the full system prompt for the given instructions. It contains
   * `Instructions.protocol`, the instructions, and the specialist runs that are working now.
   */
  readonly instructions: (instructions: string | Instructions.Resolved) => Instructions.Resolved
  /**
   * Runs the agent loop over the chat. The loop uses `Instructions.protocol`, the assistant's own
   * tools, and the instructions, tools, and skills in `options`. Every step is a tool call, and
   * the loop ends with `replyIfOwed`.
   */
  readonly loop: <T extends Record<string, Tool.Any> = Record<never, never>, RS = never>(
    options: LoopOptions<T, RS, Events>
  ) => Stream.Stream<
    AssistantLoop.Event,
    AiError.AiError,
    LanguageModel.LanguageModel | TurnServices | AssistantLoop.ToolkitServices<T> | RS
  >
  /**
   * Runs one more pass when the turn would otherwise end without a reply to the user's latest
   * message. In this pass the model can only reply.
   *
   * The stream is empty when no reply is owed, or when an input arrived that the next turn will
   * read. `loop` runs this pass with its own prompt and tools, so the pass reuses the cached
   * prompt.
   */
  readonly replyIfOwed: (
    options: ReplyOptions
  ) => Stream.Stream<AssistantLoop.Event, AiError.AiError, LanguageModel.LanguageModel | TurnServices>
}

/**
 * Represents an assistant's handler, which runs a turn and returns it as a stream of the loop's
 * events.
 *
 * The handler may return the stream directly or from an Effect. `R` is the services the stream
 * requires, and `RE` is the services the Effect requires.
 *
 * @category models
 * @since 0.1.0
 */
export type Handler<R = never, RE = R, Events = never> = (
  turn: Turn<Events>
) =>
  | Stream.Stream<AssistantLoop.Event, unknown, R>
  | Effect.Effect<Stream.Stream<AssistantLoop.Event, unknown, R>, unknown, RE>

/**
 * Computes the services an assistant's handler needs beyond those its turns provide (the turn
 * services and `LanguageModel`) and its tools' handlers (which its layer requires). These are the
 * services that its build Effect must require.
 *
 * @category utility types
 * @since 0.1.0
 */
export type HandlerServices<R> = Exclude<R, TurnServices | LanguageModel.LanguageModel | Tool.Handler<string>>

const toStream = <R, RE>(
  result:
    | Stream.Stream<AssistantLoop.Event, unknown, R>
    | Effect.Effect<Stream.Stream<AssistantLoop.Event, unknown, R>, unknown, RE>
): Stream.Stream<AssistantLoop.Event, unknown, R | RE> => (Effect.isEffect(result) ? Stream.unwrap(result) : result)

/**
 * Identifies an assistant's service in a context. Each assistant has its own identifier, keyed by
 * its name.
 *
 * @category models
 * @since 0.1.0
 */
export interface Identifier<Name extends string> {
  readonly "~effect-assistant/Assistant": Name
}

/**
 * Identifies, in a context, the chat that an assistant's turns run in.
 *
 * @category models
 * @since 0.1.0
 */
export interface ChatIdentifier<Name extends string> {
  readonly "~effect-assistant/Assistant/Chat": Name
}

/**
 * Represents the chat that a turn of this assistant runs in, typed with the assistant's events.
 *
 * Use `yield* MyAssistant.Chat` in the handler, in the handler's build, or in a tool that its
 * turns run. Code that doesn't know the assistant uses `CurrentChat` instead.
 *
 * @see {@link CurrentChat} for the same chat without the assistant's event types
 *
 * @category models
 * @since 0.1.0
 */
export interface Chat<Events = never> {
  readonly chatId: ChatId
  /**
   * The chat's entries so far, in order. They include the library's events and the assistant's
   * own events, typed.
   */
  readonly entries: Effect.Effect<ReadonlyArray<Entry<Events>>>
  /**
   * Appends events after the chat's last entry and sends them to the chat's subscribers. The
   * events can be the library's or the assistant's own, such as a summary. None of them wakes a
   * turn: only what comes in through the assistant's `submit` does.
   */
  append(...events: ReadonlyArray<AssistantEvent.AssistantEvent | Events>): Effect.Effect<void>
}

/**
 * Represents the service that `yield* MyAssistant` returns. It gives code outside a chat, such as
 * a server or a workflow, access to the assistant's chats. Code that runs inside a chat uses
 * `CurrentChat` instead.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service<Events = never> {
  /**
   * Stores an input or one of the assistant's own events, then returns. Examples are a user's
   * message or block answer, a workflow's progress, or the order the user placed. Each one is an
   * input: storing it wakes a turn, which the assistant runs in the background. The handler decides
   * what the turn does with it, and an app event the model should read needs a history view that
   * maps it (see {@link HistoryView}). To store an app event without waking a turn, append it from
   * within the chat instead (`yield* MyAssistant.Chat`).
   *
   * Fails with `GetChatError` when the app's `Chats` service reports that the chat can't be used,
   * because the app doesn't know the chat or has deleted it.
   */
  // Method syntax: a service for these events is one for any (`Service<any>`), for helpers over assistants.
  submit(chatId: ChatId, input: AssistantEvent.Input | Events): Effect.Effect<void, Chats.GetChatError>
  /**
   * Streams the chat's stored entries, then live ones, with the assistant's own events decoded.
   * A reader that already has the earlier entries passes `after` and receives only the entries
   * after that `seq`.
   *
   * For a chat client, pipe the whole log into `Timeline.changes(MyAssistant, { after })`, which
   * streams the chat's timeline, as its user sees it. Its `after` goes there, not here: a message
   * on the timeline depends on earlier entries. The timeline shows only the app events named in its
   * `show`, none by default (see `Timeline.changes`).
   */
  readonly subscribe: (
    chatId: ChatId,
    options?: { readonly after?: number | undefined }
  ) => Stream.Stream<Entry<Events>>
  /**
   * Deletes a chat by storing a `ChatDeleted` event and stopping everything that works in it.
   *
   * **Details**
   *
   * A turn or specialist run working in the chat stops, and subscribers' streams end with the
   * `ChatDeleted` event. After that the chat stores nothing more: a later input, a run's report,
   * or a workflow's event for it is dropped without an error. The log is kept, and removing it is
   * up to the app. Deleting a chat a second time does nothing.
   *
   * When the app's `Chats` service reports a chat as deleted, the assistant deletes it in the same
   * way the next time it checks. It checks before an input is stored and before each model call.
   */
  readonly delete: (chatId: ChatId) => Effect.Effect<void>
}

/**
 * Represents an assistant's definition.
 *
 * The definition holds what callers and the UI need to know about the assistant, builds its
 * handler's layer, and is the key of its service (`yield* MyAssistant`). `Events` is the type of
 * the app's own events that the assistant registered.
 *
 * @category models
 * @since 0.1.0
 */
export interface Assistant<
  Name extends string = string,
  Specs extends Specialist.Any = never,
  Events = never
> extends Context.Service<Identifier<Name>, Service<Events>> {
  readonly [TypeId]: typeof TypeId
  readonly name: Name
  readonly blocks: BlockKit.BlockKit | undefined
  /** The specialists the assistant can hand work to. */
  readonly specialists: ReadonlyArray<Specs>
  /** The schemas of the app's own events the assistant stores. */
  readonly events: ReadonlyArray<AssistantEvent.AppEventSchema>
  /**
   * Creates a layer that registers the assistant's handler with the engine and provides the
   * assistant's service.
   *
   * **Details**
   *
   * `build` is the handler, or an Effect that returns it. The handler may use the turn services,
   * `LanguageModel`, its tools' handlers (which the layer then requires), and services that its
   * build Effect required (see `Specialist.CheckServices`). The layer requires the
   * `AssistantEngine`, the `LanguageModel`, and each specialist's handler
   * (`Research.toLayer(...)`).
   *
   * **Example** (Providing an assistant's handler)
   *
   * ```ts
   * import { Assistant, AssistantEngine, ChatLog } from "effect-assistant"
   * import type * as LanguageModel from "effect/ai/LanguageModel"
   * import * as Layer from "effect/Layer"
   *
   * declare const ModelLive: Layer.Layer<LanguageModel.LanguageModel>
   *
   * export const MyAssistant = Assistant.make("my-assistant")
   *
   * const MyAssistantLive = MyAssistant.toLayer((turn) =>
   *   turn.loop({ instructions: "You help a small team. Be brief." })
   * )
   *
   * const AppLive = MyAssistantLive.pipe(
   *   Layer.provide(ModelLive),
   *   Layer.provideMerge(AssistantEngine.layerMemory),
   *   Layer.provideMerge(ChatLog.layerMemory)
   * )
   * ```
   */
  readonly toLayer: <R = never, RE = never, E = never, RX = never>(
    build: (Handler<R, RE, Events> | Effect.Effect<Handler<R, RE, Events>, E, RX>) &
      Specialist.CheckServices<Exclude<HandlerServices<R | RE>, RX | ChatIdentifier<Name>>>
  ) => Layer.Layer<
    Identifier<Name>,
    never,
    | AssistantEngine
    | LanguageModel.LanguageModel
    | Specialist.HandlerOf<Specs>
    | Exclude<RX, Scope.Scope | CurrentChat | ChatIdentifier<Name>>
    | Specialist.ToolHandlers<R | RE>
  >
  /**
   * A layer that provides the assistant's service without its handler.
   *
   * **When to use**
   *
   * Use it in a process that submits to chats that another process runs, such as a web server in
   * front of a cluster.
   *
   * **Example** (Serving clients in front of a cluster)
   *
   * ```ts
   * import { Assistant, AssistantEngine } from "effect-assistant"
   * import * as Layer from "effect/Layer"
   *
   * export const MyAssistant = Assistant.make("my-assistant")
   *
   * // Requires `Sharding`. The cluster's runners run the chats, with `AssistantEngine.layerCluster`.
   * const MyAssistantClient = MyAssistant.layerClient.pipe(
   *   Layer.provide(AssistantEngine.layerClusterClient)
   * )
   * ```
   */
  readonly layerClient: Layer.Layer<Identifier<Name>, never, AssistantEngine>
  /**
   * The key of the chat that the assistant's turns run in, typed with its events. See
   * {@link Chat}.
   */
  readonly Chat: Context.Service<ChatIdentifier<Name>, Chat<Events>>
  /** A schema that encodes the chat's entries to JSON, including the assistant's own events. */
  readonly Entry: Schema.Codec<Entry<Events>, Schema.Json>
}

/**
 * Represents any assistant, for use in generic constraints.
 *
 * @category utility types
 * @since 0.1.0
 */
export type Any = Assistant<any, any, any>

/**
 * Returns `true` when the value is an assistant's definition, created with {@link make}.
 *
 * @category guards
 * @since 0.1.0
 */
export const isAssistant = (u: unknown): u is Any => Predicate.hasProperty(u, TypeId)

function entrySchema<E>(events: ReadonlyArray<AssistantEvent.AppEventSchema>): Schema.Codec<Entry<E>, Schema.Json>
// The overload states the decoded type: the library's events, or one of these schemas' types.
function entrySchema(events: ReadonlyArray<AssistantEvent.AppEventSchema>): Schema.Top {
  return Schema.toCodecJson(
    Schema.Struct({
      chatId: ChatId,
      seq: Schema.Int,
      at: Schema.Finite,
      event: Schema.Union([AssistantEvent.AssistantEvent, ...events])
    })
  )
}

/**
 * Creates an assistant definition from its name, its UI blocks, its specialists, and the schemas of
 * the app's own events it stores.
 *
 * **Details**
 *
 * The definition holds no code that runs turns. Provide a handler with its `toLayer`, then yield
 * the definition to get the assistant's {@link Service}.
 *
 * The definition only says which of the app's events a chat stores. What happens with one is up
 * to the places that use it. One that comes in through the service's `submit`, from outside a
 * turn, is an input and wakes a turn, like a user's message; one a turn appends to its chat never
 * does. The handler decides what a turn does, a history view says how the model reads an event
 * ({@link HistoryView}), and the chat's timeline says which its user sees
 * (`Timeline.changes`).
 *
 * **Example** (Defining an assistant and submitting a message)
 *
 * ```ts
 * import { Assistant, AssistantEvent, ChatId } from "effect-assistant"
 * import * as Effect from "effect/Effect"
 *
 * export const MyAssistant = Assistant.make("my-assistant")
 *
 * const program = Effect.gen(function* () {
 *   const assistant = yield* MyAssistant
 *   const chatId = yield* ChatId.make()
 *
 *   yield* assistant.submit(chatId, AssistantEvent.UserMessage.make({ text: "Weather in Oslo?" }))
 * })
 * ```
 *
 * @see {@link Assistant} for the definition's members
 * @see {@link Service} for what `yield* MyAssistant` returns
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  const Name extends string,
  const Specs extends ReadonlyArray<Specialist.Any> = readonly [],
  const Events extends ReadonlyArray<AssistantEvent.AppEventSchema> = readonly []
>(
  name: Name,
  options?: {
    /** UI blocks the assistant can add to its messages. */
    readonly blocks?: BlockKit.BlockKit | undefined
    /**
     * The specialists the assistant can hand work to. Each specialist's `toLayer` must be
     * provided to the assistant's layer.
     */
    readonly specialists?: Specs | undefined
    /**
     * The schemas of the app's own events, each a tagged struct or class. `submit` and the chat's
     * `append` store them, in their JSON form, and the chat's `entries` and `subscribe` read them
     * back, decoded. Each needs a tag of its own that isn't one of the library's: `make` throws
     * otherwise.
     */
    readonly events?: Events | undefined
  }
): Assistant<Name, Specs[number], Events[number]["Type"]> => {
  const events = options?.events ?? []

  const definition: Turns.Definition = {
    name,
    blocks: options?.blocks,
    specialists: options?.specialists ?? [],
    app: AppEvents.make(events)
  }

  type OwnEvents = Events[number]["Type"]

  const Key = Context.Service<Identifier<Name>, Service<OwnEvents>>(`effect-assistant/Assistant/${name}`)

  // The app's own events go to the engine encoded, as they're stored; the library's go unchanged.
  const stored = (
    input: AssistantEvent.Input | OwnEvents
  ): Effect.Effect<AssistantEvent.Input | AssistantEvent.StoredAppEvent> =>
    AssistantEvent.isInput(input) ? Effect.succeed(input) : AppEvents.encode(definition.app, input)

  const ChatKey = Context.Service<ChatIdentifier<Name>, Chat<OwnEvents>>(`effect-assistant/Assistant/${name}/Chat`)

  // On the engine and the app's `Chats` the layer was given, so every caller sees the same ones.
  const makeService = Effect.gen(function* () {
    const engine = yield* AssistantEngine
    const chats = yield* Chats.Chats

    return Key.of({
      submit: Effect.fn("Assistant.submit")(function* (chatId: ChatId, input: AssistantEvent.Input | OwnEvents) {
        // Checked here, where the caller can handle it: the chat checks again when it stores the input.
        yield* chats.get(chatId)
        yield* engine.submit(name, chatId, yield* stored(input))
      }),
      subscribe: (chatId, options) =>
        engine
          .subscribe(name, chatId, options?.after ?? 0)
          .pipe(
            Stream.filterMap(
              Filter.fromPredicateOption((entry: AssistantEvent.Entry) => AppEvents.decodeEntry(definition.app, entry))
            )
          ),
      delete: (chatId) => engine.delete(name, chatId)
    })
  })

  // The signature checks what the handler uses (`CheckServices`); the layer's services, which the build
  // required, are provided to it and to every turn's stream, so what's left is the turn services.
  function toLayer<R = never, RE = never, E = never, RX = never>(
    build: (Handler<R, RE, OwnEvents> | Effect.Effect<Handler<R, RE, OwnEvents>, E, RX>) &
      Specialist.CheckServices<Exclude<HandlerServices<R | RE>, RX | ChatIdentifier<Name>>>
  ): Layer.Layer<
    Identifier<Name>,
    never,
    | AssistantEngine
    | LanguageModel.LanguageModel
    | Specialist.HandlerOf<Specs[number]>
    | Exclude<RX, Scope.Scope | CurrentChat | ChatIdentifier<Name>>
    | Specialist.ToolHandlers<R | RE>
  >
  function toLayer(
    build: Handler<any, any, any> | Effect.Effect<Handler<any, any, any>, unknown, any>
  ): Layer.Layer<Identifier<Name>, never, any> {
    return Layer.effect(
      Key,
      Effect.gen(function* () {
        const context = yield* Effect.context()

        const registration = yield* Turns.register(definition, {
          // The build runs per chat activation, in the chat; here it only keeps the layer's services for it.
          open: (typed) =>
            Effect.gen(function* () {
              // The chat's entries are already decoded with this assistant's events.
              const chat = ChatKey.of({ chatId: typed.chatId, entries: typed.entries, append: typed.append })
              const handler = Effect.isEffect(build) ? yield* Effect.provideService(build, ChatKey, chat) : build

              return (turn: Turn<any>) =>
                Stream.provideContext(toStream(handler(turn)), context).pipe(Stream.provideService(ChatKey, chat))
            }).pipe(Effect.provideContext(context), Effect.orDie)
        })

        yield* (yield* AssistantEngine).register(registration)

        return yield* makeService
      })
    )
  }

  // The key is a function, whose own `name` is read-only: the assistant's name replaces it.
  const named = Object.defineProperty(Key, "name", { value: name, writable: true })

  return Object.assign(named, {
    [TypeId]: TypeId,
    name,
    blocks: options?.blocks,
    specialists: options?.specialists ?? [],
    events,
    toLayer,
    layerClient: Layer.effect(Key, makeService),
    Chat: ChatKey,
    Entry: entrySchema<OwnEvents>(events)
  })
}
