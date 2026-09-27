/**
 * The `Assistant` module defines assistants: colleagues in a chat.
 *
 * An assistant has three parts, like an Effect workflow:
 *
 * - **Definition**: {@link make} names the assistant, its UI blocks, and its
 *   specialists. `submit` and `subscribe` are on the definition.
 * - **Handler**: `toLayer` takes a function of the {@link Turn} that returns
 *   the turn's loop as a stream, usually `turn.loop({ model, instructions, toolkit })`,
 *   and registers it with the engine. The build Effect runs once per chat
 *   activation, like an Effect cluster entity's: with the layer's services and
 *   `AssistantChat`, when the chat wakes up, and its scope closes when the chat
 *   goes idle. The function it returns runs every turn.
 * - **Engine**: `AssistantEngine.layerCluster` runs every assistant's chats
 *   as cluster entities, so a turn interrupted by a crash resumes when the
 *   cluster redelivers it; `AssistantEngine.layerMemory` runs them in the
 *   process. Pick one for the app, like a workflow engine.
 *
 * **Whom a turn acts for**
 *
 * A turn doesn't run inside the request that caused it, and some turns have
 * no request at all: a specialist's answer, a workflow's fact, an engine
 * starting again. So whom a chat is for is the app's data: its own chat
 * table, keyed by chat id. The handler looks the user up from `turn.chatId`
 * and provides what its tools need; the app checks access against the same
 * table before it submits.
 *
 * **Example** (An assistant for the chat's user)
 *
 * ```ts
 * import * as Toolkit from "@effect-uai/core/Toolkit"
 * import * as Effect from "effect/Effect"
 * import * as Layer from "effect/Layer"
 * import * as Stream from "effect/Stream"
 * import { Assistant, AssistantEngine, ChatLog } from "effect-assistant"
 * import { ChatUsers, CurrentUser } from "./CurrentUser.ts" // the app's: whose chat is it
 * import { listOrders } from "./tools.ts" // a tool that yields CurrentUser
 *
 * const MyAssistant = Assistant.make("my-assistant")
 *
 * const MyAssistantLive = MyAssistant.toLayer(Effect.gen(function*() {
 *   const users = yield* ChatUsers
 *
 *   return (turn) =>
 *     Stream.unwrap(Effect.map(users.forChat(turn.chatId), (user) =>
 *       turn.loop({
 *         model: "claude-sonnet-5",
 *         instructions: `You help ${user.name} with their orders.`,
 *         toolkit: Toolkit.make(listOrders)
 *       }).pipe(Stream.provideService(CurrentUser, user))))
 * }))
 *
 * const AppLive = MyAssistantLive.pipe(
 *   Layer.provide([ChatUsersLive, AnthropicLive]),
 *   Layer.provide(AssistantEngine.layerCluster),
 *   Layer.provide([ChatLog.layerSql, SingleRunnerLive])
 * )
 * ```
 *
 * @since 0.1.0
 */
import type * as AiError from "@effect-uai/core/AiError"
import type * as Items from "@effect-uai/core/Items"
import type * as LanguageModel from "@effect-uai/core/LanguageModel"
import type * as Toolkit from "@effect-uai/core/Toolkit"
import * as Effect from "effect/Effect"
import * as Filter from "effect/Filter"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { AssistantChat } from "./AssistantChat.ts"
import { AssistantEngine } from "./AssistantEngine.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import type * as AssistantLoop from "./AssistantLoop.ts"
import type * as BlockKit from "./BlockKit.ts"
import { ChatId } from "./ChatId.ts"
import type * as Instructions from "./Instructions.ts"
import * as AppEvents from "./internal/events.ts"
import * as Turns from "./internal/turns.ts"
import type { Skill } from "./Skill.ts"
import type * as Specialist from "./Specialist.ts"

/**
 * Services a turn provides to its tools, loop, and specialists: its chat, and
 * the chat's specialist runner.
 *
 * @category models
 * @since 0.1.0
 */
export type TurnServices = AssistantChat | Specialist.Runner

/**
 * Options for `turn.loop`.
 *
 * @category models
 * @since 0.1.0
 */
export interface LoopOptions<Tools extends Toolkit.Toolkit, R, Events = never> {
  /** The model to call, as the `LanguageModel` in context names it (e.g. `"claude-sonnet-5"`). */
  readonly model: string
  /** The assistant's role and rules. `Instructions.protocol` goes before them. */
  readonly instructions: string | Instructions.Resolved
  /** Its tools, next to its own. For tools found on demand, spread in `ToolDiscovery.make(...)`. */
  readonly toolkit?: Tools | undefined
  /** Playbooks: a catalog in the prompt, loaded with `load_skill` when a task matches. */
  readonly skills?: ReadonlyArray<Skill<R>> | undefined
  /** Model calls per turn. Default 16. */
  readonly maxSteps?: number | undefined
  /** What the reply pass tells the model when the turn would end without replying. */
  readonly replyNudge?: string | undefined
  /** Which of the chat's entries the model reads, like the ones since a summary. Default: all of them. */
  readonly history?: HistoryView<Events> | undefined
}

/**
 * Which of a chat's entries the model reads, and what else goes with them:
 * returns entries (the model reads them as usual) and history items (it
 * reads them as they are), in order.
 *
 * **Example** (The history since the last summary)
 *
 * ```ts
 * const sinceSummary: Assistant.HistoryView<Summary> = (entries) => {
 *   const last = entries.findLast((entry) => entry.event._tag === "Summary")
 *
 *   return last === undefined || last.event._tag !== "Summary"
 *     ? entries
 *     : [Items.userText(`Earlier in this chat: ${last.event.text}`), ...entries.filter((entry) => entry.seq > last.seq)]
 * }
 *
 * turn.loop({ model, instructions, history: sinceSummary })
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export type HistoryView<Events = never> = (
  entries: ReadonlyArray<Entry<Events>>
) => ReadonlyArray<Entry<Events> | Items.HistoryItem>

/**
 * A chat's entry, with the assistant's own events decoded to their types.
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
 * Options for `turn.replyIfOwed`.
 *
 * @category models
 * @since 0.1.0
 */
export interface ReplyOptions {
  readonly model: string
  /** The assistant's instructions, as for `turn.loop`: `Instructions.protocol` and the nudge are added. */
  readonly instructions: string | Instructions.Resolved
  /** What to tell the model. Default: that it hasn't replied yet, and should now. */
  readonly nudge?: string | undefined
}

/**
 * One turn, as the assistant's handler sees it. `Events` are the assistant's
 * own events (its `events` option).
 *
 * **Details**
 *
 * `loop` is the whole agent loop with the library's rules. A handler that
 * runs its own loop builds it from the parts: `history` (or `entries`, for a
 * history of its own), `tools`, `instructions`, and `AssistantLoop.step`, and
 * ends with `replyIfOwed` so a user who asked something gets an answer.
 *
 * @category models
 * @since 0.1.0
 */
export interface Turn<Events = never> {
  readonly chatId: ChatId
  /**
   * The model's history, from the chat's entries: all of them, or what a
   * view keeps. Read it before every model call; the loop does.
   */
  readonly history: (view?: HistoryView<Events>) => Effect.Effect<ReadonlyArray<Items.HistoryItem>>
  /** The chat's entries, with the assistant's own events and inputs decoded. */
  readonly entries: Effect.Effect<ReadonlyArray<Entry<Events>>>
  /** Writes the assistant's own events to the chat, like a summary for compaction. */
  readonly append: (...events: ReadonlyArray<Events>) => Effect.Effect<void>
  /** The assistant's own tools: `send_user_message`, `wait`, and the specialist tools. */
  readonly tools: Toolkit.Toolkit
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
  readonly loop: <Tools extends Toolkit.Toolkit = Record<never, never>, R = never>(
    options: LoopOptions<Tools, R, Events>
  ) => Stream.Stream<
    AssistantLoop.Event,
    AiError.AiError | AssistantLoop.ToolErrors<Tools>,
    LanguageModel.LanguageModel | AssistantLoop.ToolServices<Tools> | R
  >
  /**
   * One more pass, when the turn would end without replying to the user's
   * latest message: the model can then only reply. Empty when no reply is
   * owed, or when an input arrived that the next turn reads.
   */
  readonly replyIfOwed: (
    options: ReplyOptions
  ) => Stream.Stream<AssistantLoop.Event, AiError.AiError, LanguageModel.LanguageModel>
}

/**
 * An assistant's handler: runs a turn, as a stream of what the loop did. It
 * may return the stream from an Effect. `R` is what the stream needs, `RE`
 * what the Effect needs.
 *
 * The loop calls whatever `LanguageModel` the assistant's layer is given (like
 * effect-uai's `Anthropic.layer`), with the model `turn.loop` names.
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
 * Returns what an assistant's handler needs beyond what its turns provide
 * (the turn services and `LanguageModel`): what its build Effect must
 * require.
 *
 * @category utility types
 * @since 0.1.0
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
 * handler's layer, which registers it with the engine.
 *
 * @category models
 * @since 0.1.0
 */
export interface Assistant<
  Name extends string = string,
  Specs extends Specialist.Any = never,
  Events = never,
  Inputs = never
> {
  readonly name: Name
  readonly blocks: BlockKit.BlockKit | undefined
  /** The specialists it can hand work to. */
  readonly specialists: ReadonlyArray<Specs>
  /**
   * Registers the assistant's handler with the engine. The handler may use
   * the turn services, `LanguageModel`, and services its build Effect
   * required (see `Specialist.CheckServices`). The layer needs the model API
   * and each specialist's handler (`Research.toLayer(...)`).
   */
  readonly toLayer: <R = never, RE = never, E = never, RX = never>(
    build: (Handler<R, RE, Events | Inputs> | Effect.Effect<Handler<R, RE, Events | Inputs>, E, RX>) &
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
   * Stores an input and returns: a user's message or block answer, a fact
   * (a workflow update, say), or one of the assistant's own `inputs`. The
   * assistant works on it in the background.
   */
  readonly submit: (chatId: ChatId, input: AssistantEvent.Input | Inputs) => Effect.Effect<void, never, AssistantEngine>
  /**
   * Streams the chat's entries (those after `after`, for a client that has
   * the rest), then live ones, with the assistant's own events decoded.
   */
  readonly subscribe: (
    chatId: ChatId,
    options?: { readonly after?: number | undefined }
  ) => Stream.Stream<Entry<Events | Inputs>, never, AssistantEngine>
  /** Schema for the chat's entries, the assistant's own events included: for an RPC that streams them. */
  readonly Entry: Schema.Codec<Entry<Events | Inputs>, Schema.Json>
}

/**
 * A schema for one of the app's own events or inputs: a tagged struct or
 * class (`Schema.TaggedStruct`, `Schema.TaggedClass`) that needs no services.
 *
 * @category models
 * @since 0.1.0
 */
export type EventSchema = Schema.Codec<{ readonly _tag: string }, { readonly _tag: string }> & {
  readonly fields: { readonly _tag: { readonly ast: SchemaAST.AST } }
}

/**
 * Any assistant.
 *
 * @category models
 * @since 0.1.0
 */
export type Any = Assistant<any, any, any, any>

/** The entry schema for these app schemas, in JSON: the library's events, and the app's. */
function entrySchema<E>(schemas: ReadonlyArray<EventSchema>): Schema.Codec<Entry<E>, Schema.Json>
// The overload states the decoded type: the library's events, or one of these schemas' types.
function entrySchema(schemas: ReadonlyArray<EventSchema>): Schema.Top {
  return Schema.toCodecJson(
    Schema.Struct({
      chatId: ChatId,
      seq: Schema.Int,
      at: Schema.Finite,
      event: Schema.Union([AssistantEvent.AssistantEvent, ...schemas])
    })
  )
}

/**
 * Defines an assistant: its name, its UI blocks, its specialists, and its own
 * events and inputs.
 *
 * **Example** (Defining an assistant)
 *
 * ```ts
 * import * as Schema from "effect/Schema"
 * import { Assistant } from "effect-assistant"
 *
 * const FileUploaded = Schema.TaggedStruct("FileUploaded", { id: InputId.InputId, name: Schema.String })
 *
 * export const MyAssistant = Assistant.make("my-assistant", {
 *   blocks: Blocks,
 *   specialists: [Research],
 *   inputs: [FileUploaded]
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  const Name extends string,
  const Specs extends ReadonlyArray<Specialist.Any> = readonly [],
  const Events extends ReadonlyArray<EventSchema> = readonly [],
  const Inputs extends ReadonlyArray<EventSchema> = readonly []
>(
  name: Name,
  options?: {
    /** UI blocks the assistant can add to its messages. */
    readonly blocks?: BlockKit.BlockKit | undefined
    /** The specialists it can hand work to; each needs its `toLayer` provided to the assistant's. */
    readonly specialists?: Specs | undefined
    /**
     * The app's own events, like a summary for compaction: tagged schemas.
     * `turn.append` writes them to the chat and `turn.entries` reads them
     * back, typed. The model doesn't read them, unless a history view puts
     * them in.
     */
    readonly events?: Events | undefined
    /**
     * The app's own inputs, like an uploaded file: tagged schemas. `submit`
     * takes them, they wake a turn like a fact, and the model reads them.
     * One with an `id` is stored once per id.
     */
    readonly inputs?: Inputs | undefined
  }
): Assistant<Name, Specs[number], Events[number]["Type"], Inputs[number]["Type"]> => {
  const events = options?.events ?? []
  const inputs = options?.inputs ?? []

  const definition: Turns.Definition = {
    name,
    blocks: options?.blocks,
    specialists: options?.specialists ?? [],
    app: AppEvents.make(events, inputs)
  }

  // The signature checks what the handler uses (`CheckServices`); the layer's services, which the build
  // required, are provided to it and to every turn's stream, so what's left is the turn services.
  function toLayer<R = never, RE = never, E = never, RX = never>(
    build: (
      | Handler<R, RE, Events[number]["Type"] | Inputs[number]["Type"]>
      | Effect.Effect<Handler<R, RE, Events[number]["Type"] | Inputs[number]["Type"]>, E, RX>
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

        const registration = yield* Turns.makeRegistration(definition, {
          // The build runs per chat activation, in the chat; here it only keeps the layer's services for it.
          open: (Effect.isEffect(build) ? build : Effect.succeed(build)).pipe(
            Effect.map((handler) => (turn: Turn<any>) => Stream.provideContext(toStream(handler(turn)), context)),
            Effect.provideContext(context),
            Effect.orDie
          )
        })

        yield* (yield* AssistantEngine).register(registration)
      })
    )
  }

  // The app's own inputs go to the engine as they're stored; the library's as they are.
  const stored = (
    input: AssistantEvent.Input | Inputs[number]["Type"]
  ): Effect.Effect<AssistantEvent.Input | AssistantEvent.AppEvent> =>
    AssistantEvent.isLibraryEvent(input) && AssistantEvent.isInput(input)
      ? Effect.succeed(input)
      : AppEvents.encode(definition.app, input)

  const assistant: Assistant<Name, Specs[number], Events[number]["Type"], Inputs[number]["Type"]> = {
    name,
    blocks: options?.blocks,
    specialists: options?.specialists ?? [],
    toLayer,
    submit: (chatId, input) =>
      Effect.flatMap(stored(input), (event) => AssistantEngine.use((engine) => engine.submit(name, chatId, event))),
    subscribe: (chatId, options) =>
      Stream.unwrap(AssistantEngine.useSync((engine) => engine.subscribe(name, chatId, options?.after ?? 0))).pipe(
        Stream.filterMap(
          Filter.fromPredicateOption((entry: AssistantEvent.Entry) => AppEvents.decodeEntry(definition.app, entry))
        )
      ),
    Entry: entrySchema([...events, ...inputs])
  }

  return assistant
}
