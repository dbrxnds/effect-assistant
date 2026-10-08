/** The `Assistant` module defines assistants: colleagues in a chat. */
import type * as AiError from "effect/ai/AiError"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Prompt from "effect/ai/Prompt"
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Filter from "effect/Filter"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as AppEvent from "./AppEvent.ts"
import { AssistantChat } from "./AssistantChat.ts"
import { AssistantEngine } from "./AssistantEngine.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import type * as AssistantLoop from "./AssistantLoop.ts"
import type * as BlockKit from "./BlockKit.ts"
import { ChatId } from "./ChatId.ts"
import * as Chats from "./Chats.ts"
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
export interface LoopOptions<T extends Record<string, Tool.Any> = Record<never, never>, RS = never, Events = never> {
  /** The assistant's role and rules. `Instructions.protocol` goes before them. */
  readonly instructions: string | Instructions.Resolved
  /**
   * Its tools, next to its own: a native toolkit, with its handlers from the layer. Merge several with
   * `Toolkit.merge`, like `Memory.Tools` or a `ToolDiscovery.make(...)` toolkit with yours.
   */
  readonly toolkit?: Toolkit.Toolkit<T> | undefined
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
   * The full system prompt for these instructions: `Instructions.protocol`,
   * the instructions, and the specialist runs working now.
   */
  readonly instructions: (instructions: string | Instructions.Resolved) => Instructions.Resolved
  /**
   * The agent loop over the chat, with `Instructions.protocol`, the assistant's own tools,
   * and these instructions, tools, and skills. Every step is a tool call. It
   * ends with `replyIfOwed`.
   */
  readonly loop: <T extends Record<string, Tool.Any> = Record<never, never>, RS = never>(
    options: LoopOptions<T, RS, Events>
  ) => Stream.Stream<
    AssistantLoop.Event,
    AiError.AiError,
    LanguageModel.LanguageModel | TurnServices | AssistantLoop.ToolkitServices<T> | RS
  >
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
 * (the turn services and `LanguageModel`) and its tools' handlers (which its
 * layer needs): what its build Effect must require.
 */
export type HandlerServices<R> = Exclude<R, TurnServices | LanguageModel.LanguageModel | Tool.Handler<string>>

/** A handler's result as a stream: it may return the stream from an Effect. */
const toStream = <R, RE>(
  result:
    | Stream.Stream<AssistantLoop.Event, unknown, R>
    | Effect.Effect<Stream.Stream<AssistantLoop.Event, unknown, R>, unknown, RE>
): Stream.Stream<AssistantLoop.Event, unknown, R | RE> => (Effect.isEffect(result) ? Stream.unwrap(result) : result)

/** Identifies an assistant's service in a context: one per assistant, by its name. */
export interface Identifier<Name extends string> {
  readonly "~effect-assistant/Assistant": Name
}

/** Identifies an assistant's chat in a context: the one its turns run in. */
export interface ChatIdentifier<Name extends string> {
  readonly "~effect-assistant/Assistant/Chat": Name
}

/**
 * The chat a turn of this assistant runs in, typed with its events:
 * `yield* MyAssistant.Chat` in its handler, the handler's build, or a tool
 * its turns run. Code that doesn't know the assistant uses `AssistantChat`.
 */
export interface Chat<Events = never> {
  readonly chatId: ChatId
  /** The chat's entries so far, in order: the library's events, and the assistant's own, typed. */
  readonly entries: Effect.Effect<ReadonlyArray<Entry<Events>>>
  /**
   * Appends events after the chat's last entry and sends them to its
   * subscribers: the library's, or the assistant's own, like a summary. One
   * that wakes a turn gets the next turn.
   */
  append(...events: ReadonlyArray<AssistantEvent.AssistantEvent | Events>): Effect.Effect<void>
}

/**
 * What `yield* MyAssistant` gives: its chats, from outside them, like a
 * server or a workflow. Code in a chat uses `AssistantChat`.
 */
export interface Service<Events = never> {
  /**
   * Stores an input or one of the assistant's own events, and returns: a
   * user's message or block answer, a workflow's progress, the draft the
   * user opened. The assistant works on what wakes a turn in the background.
   * Fails when the app says the chat can't be used (see `Chats`): it doesn't
   * know it, or deleted it.
   */
  // Method syntax: a service for these events is one for any (`Service<any>`), for helpers over assistants.
  submit(chatId: ChatId, input: AssistantEvent.Input | Events): Effect.Effect<void, Chats.GetChatError>
  /**
   * Streams the chat's whole log (the entries after `after`, for a reader
   * that has the rest), then live ones, with the assistant's own events
   * decoded.
   */
  readonly subscribe: (
    chatId: ChatId,
    options?: { readonly after?: number | undefined }
  ) => Stream.Stream<Entry<Events>>
  /**
   * Streams the chat as its user sees it, for a chat client: what changed in
   * its messages, blocks, and activity (see `ChatView`), from the start, then
   * live. A client that has the view up to a `seq` passes it as `after`, and
   * gets only what changed since.
   */
  readonly subscribeView: (
    chatId: ChatId,
    options?: { readonly after?: number | undefined }
  ) => Stream.Stream<ChatView.Update>
  /**
   * Deletes a chat: stores a `ChatDeleted`, and stops what works in it. A
   * turn or specialist run working in it stops, subscribers' streams end with
   * the `ChatDeleted`, and the chat stores nothing again: a later input, a
   * run's report, or a workflow's event for it is dropped, quietly. The log
   * stays; removing it is the app's. Deleting it again does nothing.
   *
   * A chat the app says is deleted (see `Chats`) is deleted the same way
   * when the assistant next asks: before an input is stored, and before each
   * model call.
   */
  readonly delete: (chatId: ChatId) => Effect.Effect<void>
}

/**
 * An assistant's definition: what callers and the UI need to know, its
 * handler's layer, and the key of its service (`yield* MyAssistant`).
 * `Events` are the app's own events it registered.
 */
export interface Assistant<
  Name extends string = string,
  Specs extends Specialist.Any = never,
  Events = never
> extends Context.Service<Identifier<Name>, Service<Events>> {
  readonly name: Name
  readonly blocks: BlockKit.BlockKit | undefined
  /** The specialists it can hand work to. */
  readonly specialists: ReadonlyArray<Specs>
  /** The app's own events it registered. */
  readonly events: ReadonlyArray<AppEvent.Any>
  /**
   * Registers the assistant's handler with the engine, and provides its
   * service. The handler may use the turn services, `LanguageModel`, its
   * tools' handlers (which the layer then needs), and services its build
   * Effect required (see `Specialist.CheckServices`). The layer needs the
   * model API and each specialist's handler (`Research.toLayer(...)`).
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
    | Exclude<RX, Scope.Scope | AssistantChat | ChatIdentifier<Name>>
    | Specialist.ToolHandlers<R | RE>
  >
  /**
   * Layer for the assistant's service only, without its handler: for a
   * process that submits to chats another one runs, like a web server in
   * front of a cluster.
   */
  readonly layerClient: Layer.Layer<Identifier<Name>, never, AssistantEngine>
  /** The key of the chat its turns run in, typed with its events: see {@link Chat}. */
  readonly Chat: Context.Service<ChatIdentifier<Name>, Chat<Events>>
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
     * each. `submit` and `AssistantChat`'s `append` store them, and its
     * `entries` read them back, decoded. Those that wake a turn are inputs, and the model
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

  type OwnEvents = AppEvent.Type<Events[number]>

  const Key = Context.Service<Identifier<Name>, Service<OwnEvents>>(`effect-assistant/Assistant/${name}`)

  // The app's own events go to the engine as they're stored; the library's as they are.
  const stored = (
    input: AssistantEvent.Input | OwnEvents
  ): Effect.Effect<AssistantEvent.Input | AssistantEvent.StoredAppEvent> =>
    AssistantEvent.isInput(input) ? Effect.succeed(input) : AppEvents.encode(definition.app, input)

  const ChatKey = Context.Service<ChatIdentifier<Name>, Chat<OwnEvents>>(`effect-assistant/Assistant/${name}/Chat`)

  // The assistant's own events, as its schemas decode them: what its typed chat keeps of the entries.
  const isOwn = Schema.is(Schema.Union(events.map((event) => event.schema)))

  /** The chat a turn runs in, typed with this assistant's events. */
  const typedChat = (chat: AssistantChat["Service"]): Chat<OwnEvents> =>
    ChatKey.of({
      chatId: chat.chatId,
      entries: Effect.map(chat.entries, (all) =>
        all.flatMap(({ chatId, seq, at, event }) =>
          AssistantEvent.isLibraryEvent(event) || isOwn(event) ? [{ chatId, seq, at, event }] : []
        )
      ),
      append: (...appended) => chat.append(...appended)
    })

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
      subscribeView: (chatId, options) =>
        ChatView.updates(engine.subscribe(name, chatId, 0), { wakes: definition.app.wakes, after: options?.after }),
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
    | Exclude<RX, Scope.Scope | AssistantChat | ChatIdentifier<Name>>
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
          open: Effect.gen(function* () {
            const chat = typedChat(yield* AssistantChat)
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
