/**
 * This module provides the `AssistantEngine` service, which runs assistants' chats, and its
 * implementations.
 *
 * An assistant's `toLayer` registers the assistant with the engine, and the assistant's `submit`
 * and `subscribe` go through it. Pick one engine for the app, as with a workflow engine.
 * {@link layerMemory} runs chats in the process, for tests and single-process apps.
 * {@link layerCluster} runs each chat as a cluster entity, so a turn cut off by a crash resumes, and
 * {@link layerClusterClient} reaches those chats from a process that runs none.
 *
 * @since 0.1.0
 */
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as Entity from "effect/cluster/Entity"
import * as Sharding from "effect/cluster/Sharding"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as RcMap from "effect/RcMap"
import * as Rpc from "effect/rpc/Rpc"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as AssistantEvent from "./AssistantEvent.ts"
import { ChatId } from "./ChatId.ts"
import { ChatLog } from "./ChatLog.ts"
import * as Chat from "./internal/chat.ts"
import * as History from "./internal/history.ts"
import type * as Turns from "./internal/turns.ts"

/**
 * Service that runs assistants' chats. An assistant's `toLayer` registers the assistant with it,
 * and the assistant's `submit` and `subscribe` use it.
 *
 * @category services
 * @since 0.1.0
 */
export class AssistantEngine extends Context.Service<
  AssistantEngine,
  {
    /** Registers an assistant for as long as the scope is open. */
    readonly register: (registration: Turns.Registration) => Effect.Effect<void, never, Scope.Scope>
    /**
     * Stores an input in one of the assistant's chats. The assistant works on it in the
     * background.
     */
    readonly submit: (
      assistant: string,
      chatId: ChatId,
      input: AssistantEvent.Input | AssistantEvent.StoredAppEvent
    ) => Effect.Effect<void>
    /** Streams the chat's stored entries after the `after` sequence, then live ones. */
    readonly subscribe: (assistant: string, chatId: ChatId, after: number) => Stream.Stream<AssistantEvent.Entry>
    /**
     * Deletes one of the assistant's chats. The chat's log records the deletion, and everything
     * that works in the chat stops.
     */
    readonly delete: (assistant: string, chatId: ChatId) => Effect.Effect<void>
  }
>()("effect-assistant/AssistantEngine") {}

class ChatKey extends Data.Class<{ readonly assistant: string; readonly chatId: ChatId }> {}

const notRegistered = (assistant: string) =>
  Effect.die(`The ${assistant} assistant isn't registered: provide its toLayer.`)

/**
 * Layer that runs chats in the current process. Each chat's turns run as fibers, one at a time.
 *
 * **Details**
 *
 * With `ChatLog.layerSql`, the engine resumes chats at startup. When an assistant registers, the
 * engine finds the chats that assistant was working on when the process stopped (a turn cut off
 * partway, or an input that no turn read) and runs a turn for each. Run this engine in one process
 * only, because two processes would run the same chat and write its log at the same time.
 *
 * **Example** (Running chats in memory)
 *
 * ```ts
 * import { Assistant, AssistantEngine, ChatLog } from "effect-assistant"
 * import type * as LanguageModel from "effect/ai/LanguageModel"
 * import * as Layer from "effect/Layer"
 *
 * declare const ModelLive: Layer.Layer<LanguageModel.LanguageModel>
 *
 * const MyAssistant = Assistant.make("my-assistant")
 *
 * const AppLive = MyAssistant.toLayer((turn) => turn.run({ instructions: "Be brief." })).pipe(
 *   Layer.provide(ModelLive),
 *   Layer.provideMerge(AssistantEngine.layerMemory),
 *   Layer.provideMerge(ChatLog.layerMemory)
 * )
 * ```
 *
 * @see {@link layerCluster} for running each chat as a cluster entity
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory: Layer.Layer<AssistantEngine, never, ChatLog> = Layer.effect(
  AssistantEngine,
  Effect.gen(function* () {
    const context = yield* Effect.context<ChatLog>()
    const log = yield* ChatLog
    const registered = new Map<string, Turns.Registration>()
    // A chat's keep-alive: a hold on its entry, so it stays open while runs or turns work in the background.
    const held = MutableHashMap.empty<ChatKey, Scope.Closeable>()

    // One entry per open chat, like a cluster entity: opened when used, closed five minutes after the last use.
    const chats: RcMap.RcMap<ChatKey, Chat.Chat> = yield* RcMap.make({
      lookup: Effect.fnUntraced(function* (key: ChatKey) {
        const registration = registered.get(key.assistant)

        if (registration === undefined) return yield* notRegistered(key.assistant)

        return yield* Chat.make({
          registration,
          chatId: key.chatId,
          keepAlive: (enabled) => keepAlive(key, enabled)
        }).pipe(Effect.provide(context))
      }),
      idleTimeToLive: "5 minutes"
    })

    // On: a hold on the chat's entry, in a scope of its own. Off: closing that scope lets the entry go idle.
    const keepAlive = Effect.fnUntraced(function* (key: ChatKey, enabled: boolean) {
      if (enabled) {
        const scope = yield* Scope.make()

        yield* Effect.provideService(RcMap.get(chats, key), Scope.Scope, scope)

        return MutableHashMap.set(held, key, scope)
      }

      const scope = MutableHashMap.get(held, key)

      MutableHashMap.remove(held, key)

      if (Option.isSome(scope)) yield* Scope.close(scope.value, Exit.void)
    })

    const withChat = Effect.fnUntraced(function* <A>(
      assistant: string,
      chatId: ChatId,
      f: (chat: Chat.Chat) => Effect.Effect<A>
    ) {
      const chat = yield* RcMap.get(chats, new ChatKey({ assistant, chatId }))

      return yield* f(chat)
    }, Effect.scoped)

    // A chat owes a turn when its last turn was cut off, or an input came after.
    const resumeAll = Effect.fnUntraced(function* (registration: Turns.Registration) {
      const { name } = registration.definition

      for (const chatId of yield* log.unfinished) {
        const entries = yield* log.read(chatId)

        const lastTurn = entries.findLast(({ event }) => Predicate.isTagged(event, "TurnStarted"))?.event
        const ours = Predicate.isTagged(lastTurn, "TurnStarted") && lastTurn.assistant === name

        if (ours && History.needsTurn(entries)) yield* withChat(name, chatId, (chat) => chat.resume)
      }
    })

    return AssistantEngine.of({
      register: Effect.fn("AssistantEngine.register")(function* (registration: Turns.Registration) {
        registered.set(registration.definition.name, registration)
        // Chats this assistant was working on when the process stopped: pick them up again.
        yield* Effect.forkScoped(resumeAll(registration))
      }),
      submit: (assistant, chatId, input) => withChat(assistant, chatId, (chat) => chat.submitInBackground(input)),
      // The chat deletes itself, so a chat that's open stops; the entry goes, and the next open finds it deleted.
      delete: Effect.fn("AssistantEngine.delete")(function* (assistant: string, chatId: ChatId) {
        yield* withChat(assistant, chatId, (chat) => chat.delete)
        yield* RcMap.invalidate(chats, new ChatKey({ assistant, chatId }))
      }),
      // The subscriber holds the chat open while it streams.
      subscribe: (assistant, chatId, after) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const chat = yield* RcMap.get(chats, new ChatKey({ assistant, chatId }))

            return chat.stream(after)
          })
        )
    })
  })
)

interface EntityClient {
  readonly submit: (chatId: ChatId, input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) => Effect.Effect<void>
  readonly subscribe: (chatId: ChatId, after: number) => Stream.Stream<AssistantEvent.Entry>
  readonly delete: (chatId: ChatId) => Effect.Effect<void>
}

const Submit = Rpc.make("Submit", {
  payload: { input: Schema.Union([AssistantEvent.Input, AssistantEvent.StoredAppEvent]) }
}).annotate(ClusterSchema.Persisted, true)

const Subscribe = Rpc.make("Subscribe", {
  payload: { after: Schema.Int },
  success: AssistantEvent.Entry,
  stream: true
})

const Delete = Rpc.make("Delete")

const chatEntity = (assistant: string) => Entity.make(`Assistant/${assistant}`, [Submit, Subscribe, Delete])

type EngineClient = Omit<AssistantEngine["Service"], "register">

// Entity clients are made on first use, so a process that registers no assistant can still reach its chats.
const makeClusterClient = Effect.gen(function* () {
  const context = yield* Effect.context<Sharding.Sharding>()
  const clients = new Map<string, EntityClient>()

  const clientOf = Effect.fnUntraced(function* (assistant: string) {
    const known = clients.get(assistant)

    if (known !== undefined) return known

    const makeClient = yield* chatEntity(assistant).client.pipe(Effect.provide(context))

    const client: EntityClient = {
      submit: (chatId, input) => makeClient(chatId).Submit({ input }, { discard: true }).pipe(Effect.orDie),
      subscribe: (chatId, after) => makeClient(chatId).Subscribe({ after }).pipe(Stream.orDie),
      delete: (chatId) => makeClient(chatId).Delete().pipe(Effect.orDie)
    }

    clients.set(assistant, client)

    return client
  })

  const engine: EngineClient = {
    submit: Effect.fn("AssistantEngine.submit")(function* (
      assistant: string,
      chatId: ChatId,
      input: AssistantEvent.Input | AssistantEvent.StoredAppEvent
    ) {
      const client = yield* clientOf(assistant)

      yield* client.submit(chatId, input)
    }),
    subscribe: (assistant, chatId, after) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const client = yield* clientOf(assistant)

          return client.subscribe(chatId, after)
        })
      ),
    delete: Effect.fn("AssistantEngine.delete")(function* (assistant: string, chatId: ChatId) {
      const client = yield* clientOf(assistant)

      yield* client.delete(chatId)
    })
  }

  return engine
})

/**
 * Layer that runs chats as cluster entities, one entity per chat, keyed by chat id.
 *
 * **Details**
 *
 * The layer requires `Sharding`. Use a `SingleRunner` for one process with SQL storage, a runner
 * of the app's cluster, or `TestRunner` in tests.
 *
 * **Example** (Running chats on a single runner with Postgres)
 *
 * ```ts
 * import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
 * import * as PgClient from "@effect/sql-pg/PgClient"
 * import { Assistant, AssistantEngine, ChatLog } from "effect-assistant"
 * import type * as LanguageModel from "effect/ai/LanguageModel"
 * import * as SingleRunner from "effect/cluster/SingleRunner"
 * import * as Config from "effect/Config"
 * import * as Layer from "effect/Layer"
 *
 * declare const ModelLive: Layer.Layer<LanguageModel.LanguageModel>
 *
 * const MyAssistant = Assistant.make("my-assistant")
 *
 * const AppLive = MyAssistant.toLayer((turn) => turn.run({ instructions: "Be brief." })).pipe(
 *   Layer.provide(ModelLive),
 *   Layer.provideMerge(AssistantEngine.layerCluster),
 *   Layer.provideMerge(
 *     Layer.merge(
 *       ChatLog.layerSql,
 *       SingleRunner.layer({ runnerStorage: "sql" }).pipe(Layer.provide(NodeCrypto.layer))
 *     )
 *   ),
 *   Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }))
 * )
 * ```
 *
 * @see {@link layerMemory} for running chats in one process
 * @see {@link layerClusterClient} for a process that only reaches chats the cluster runs
 *
 * @category layers
 * @since 0.1.0
 */
export const layerCluster: Layer.Layer<AssistantEngine, never, ChatLog | Sharding.Sharding> = Layer.effect(
  AssistantEngine,
  Effect.gen(function* () {
    const context = yield* Effect.context<ChatLog | Sharding.Sharding>()
    const sharding = yield* Sharding.Sharding

    const register = Effect.fnUntraced(function* (registration: Turns.Registration) {
      const ChatEntity = chatEntity(registration.definition.name)

      const handlers = Effect.gen(function* () {
        const address = yield* Entity.CurrentAddress
        const chatId = yield* Schema.decodeUnknownEffect(ChatId)(address.entityId).pipe(Effect.orDie)
        // The entity's own: `Entity.keepAlive` needs its address and keep-alive latch, which is in there too.
        const entityContext = yield* Effect.context<Entity.CurrentAddress | Sharding.Sharding>()

        const keepAlive = (enabled: boolean) =>
          Entity.keepAlive(enabled).pipe(
            Effect.provide(entityContext),
            Effect.catchCause((cause) => Effect.logWarning("assistant chat keep-alive failed", cause))
          )

        // A keep-alive left on from before a restart (by a run cut off) has done its job: it started the entity.
        yield* keepAlive(false)

        const chat = yield* Chat.make({ registration, chatId, keepAlive })
        yield* chat.resume

        return ChatEntity.of({
          // The turns run inside the request, so a crash leaves it unprocessed and the cluster redelivers it.
          Submit: (request) => chat.submit(request.payload.input),
          Subscribe: (request) => chat.stream(request.payload.after),
          Delete: () => chat.delete
        })
      })

      yield* sharding.registerEntity(ChatEntity, handlers.pipe(Effect.provide(context)), {
        maxIdleTime: "5 minutes",
        concurrency: "unbounded"
      })
    })

    const client = yield* makeClusterClient

    return AssistantEngine.of({
      register: (registration) => register(registration).pipe(Effect.provide(context)),
      ...client
    })
  })
)

/**
 * Layer that reaches chats running as cluster entities elsewhere, and runs none itself.
 *
 * **When to use**
 *
 * Use it in a process that only submits to, subscribes to, and deletes chats that the cluster's
 * runners run with {@link layerCluster}, such as a web server that provides an assistant's
 * `layerClient`. It needs no `ChatLog`, since the runners store the chats.
 *
 * **Details**
 *
 * The layer requires `Sharding`. An assistant's `toLayer` can't register with it: it dies, since
 * no chats run in this process.
 *
 * **Example** (A web server in front of the cluster)
 *
 * ```ts
 * import { Assistant, AssistantEngine } from "effect-assistant"
 * import type * as Sharding from "effect/cluster/Sharding"
 * import * as Layer from "effect/Layer"
 *
 * declare const ShardingLive: Layer.Layer<Sharding.Sharding>
 *
 * export const MyAssistant = Assistant.make("my-assistant")
 *
 * const MyAssistantClient = MyAssistant.layerClient.pipe(
 *   Layer.provide(AssistantEngine.layerClusterClient),
 *   Layer.provide(ShardingLive)
 * )
 * ```
 *
 * @see {@link layerCluster} for the runners that run the chats
 *
 * @category layers
 * @since 0.3.0
 */
export const layerClusterClient: Layer.Layer<AssistantEngine, never, Sharding.Sharding> = Layer.effect(
  AssistantEngine,
  Effect.gen(function* () {
    const client = yield* makeClusterClient

    return AssistantEngine.of({
      register: (registration) =>
        Effect.die(
          `The ${registration.definition.name} assistant can't register with AssistantEngine.layerClusterClient, which runs no chats: provide AssistantEngine.layerCluster where its toLayer runs.`
        ),
      ...client
    })
  })
)
