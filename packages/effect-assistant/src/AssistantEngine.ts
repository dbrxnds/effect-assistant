/**
 * The `AssistantEngine` module runs assistants' chats. An assistant's
 * `toLayer` registers it with the engine, and its `submit` and
 * `subscribe` go through it. Pick one engine for the app, like a workflow
 * engine:
 *
 * - {@link layerCluster} runs each chat as a cluster entity. `submit` sends
 *   the chat's entity a persisted message and returns; the entity stores the
 *   input and runs turns until nothing is pending. A crash mid-turn leaves
 *   the message unprocessed, so the cluster redelivers it and the work
 *   resumes.
 * - {@link layerMemory} runs each chat in the process: `submit` stores the
 *   input, and a fiber runs turns until nothing is pending.
 *
 * Either one runs one turn per chat at a time, and keeps the chat's
 * specialist runs with it. A run's answer is stored in the chat and gets a
 * turn, like an input.
 *
 * **Example** (One engine for the app)
 *
 * ```ts
 * import * as Layer from "effect/Layer"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
 * import { AssistantEngine, ChatLog } from "effect-assistant"
 *
 * const AppLive = Layer.mergeAll(MyAssistantLive, ResearchLive).pipe(
 *   Layer.provide(AssistantEngine.layerCluster),
 *   Layer.provide([ChatLog.layerSql, SingleRunnerLive])
 * )
 * ```
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as RcMap from "effect/RcMap"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as ClusterSchema from "effect/unstable/cluster/ClusterSchema"
import * as Entity from "effect/unstable/cluster/Entity"
import * as Sharding from "effect/unstable/cluster/Sharding"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as AssistantEvent from "./AssistantEvent.ts"
import { ChatId } from "./ChatId.ts"
import { ChatLog } from "./ChatLog.ts"
import * as Chat from "./internal/chat.ts"
import * as History from "./internal/history.ts"
import type * as Turns from "./internal/turns.ts"

/**
 * Service that runs assistants' chats. `toLayer` registers an assistant with
 * it; the assistant's `submit` and `subscribe` use it.
 *
 * @category services
 * @since 0.1.0
 */
export class AssistantEngine extends Context.Service<
  AssistantEngine,
  {
    /** Registers an assistant, for as long as the scope is open. */
    readonly register: (registration: Turns.Registration) => Effect.Effect<void, never, Scope.Scope>
    /** Stores an input in a chat of the assistant, which works on it in the background. */
    readonly submit: (
      assistant: string,
      chatId: ChatId,
      input: AssistantEvent.Input | AssistantEvent.AppEvent
    ) => Effect.Effect<void>
    /** Streams the chat's stored events after `after`, then live ones. */
    readonly subscribe: (assistant: string, chatId: ChatId, after: number) => Stream.Stream<AssistantEvent.Entry>
  }
>()("effect-assistant/AssistantEngine") {}

/** An open chat of the in-memory engine: which assistant, which chat. */
class ChatKey extends Data.Class<{ readonly assistant: string; readonly chatId: ChatId }> {}

const notRegistered = (assistant: string) =>
  Effect.die(`The ${assistant} assistant isn't registered: provide its toLayer.`)

/**
 * Layer that runs chats in the process. Each chat's turns are fibers, one at
 * a time.
 *
 * **Details**
 *
 * When an assistant registers, the engine picks up the chats it was working
 * on when the process stopped: a turn cut off mid-way, or an input no turn
 * read, gets a turn. The log keeps every step, so the turn goes on from the
 * last one recorded. Run it in one process only: two would run the same
 * chat's turns and write its log at once.
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
      lookup: Effect.fn(function* (key: ChatKey) {
        const registration = registered.get(key.assistant)

        if (registration === undefined) return yield* notRegistered(key.assistant)

        return yield* Chat.makeChat({
          registration,
          chatId: key.chatId,
          keepAlive: (enabled) => keepAlive(key, enabled)
        }).pipe(Effect.provide(context))
      }),
      idleTimeToLive: "5 minutes"
    })

    // On: a hold on the chat's entry, in a scope of its own. Off: closing that scope lets the entry go idle.
    const keepAlive = Effect.fn(function* (key: ChatKey, enabled: boolean) {
      if (enabled) {
        const scope = yield* Scope.make()

        yield* Effect.provideService(RcMap.get(chats, key), Scope.Scope, scope)

        return MutableHashMap.set(held, key, scope)
      }

      const scope = MutableHashMap.get(held, key)

      MutableHashMap.remove(held, key)

      if (Option.isSome(scope)) yield* Scope.close(scope.value, Exit.void)
    })

    const withChat = <A>(assistant: string, chatId: ChatId, f: (chat: Chat.Chat) => Effect.Effect<A>) =>
      Effect.scoped(RcMap.get(chats, new ChatKey({ assistant, chatId })).pipe(Effect.flatMap(f)))

    /** Runs turns for the assistant's chats that owe one: its last turn was cut off, or an input came after. */
    const resumeAll = Effect.fn(function* (registration: Turns.Registration) {
      const { name, app } = registration.definition

      for (const chatId of yield* log.unfinished) {
        const entries = yield* log.read(chatId)

        const lastTurn = entries.findLast(({ event }) => Predicate.isTagged(event, "TurnStarted"))?.event
        const ours = Predicate.isTagged(lastTurn, "TurnStarted") && lastTurn.assistant === name

        if (ours && History.needsTurn(entries, app.inputs)) yield* withChat(name, chatId, (chat) => chat.resume)
      }
    })

    return AssistantEngine.of({
      register: Effect.fn(function* (registration: Turns.Registration) {
        registered.set(registration.definition.name, registration)
        // Chats this assistant was working on when the process stopped: pick them up again.
        yield* Effect.forkScoped(resumeAll(registration))
      }),
      submit: (assistant, chatId, input) => withChat(assistant, chatId, (chat) => chat.submitInBackground(input)),
      // The subscriber holds the chat open while it streams.
      subscribe: (assistant, chatId, after) =>
        Stream.unwrap(
          RcMap.get(chats, new ChatKey({ assistant, chatId })).pipe(Effect.map((chat) => chat.stream(after)))
        )
    })
  })
)

/** A registered assistant's chats, through their entities. */
interface EntityClient {
  readonly submit: (chatId: ChatId, input: AssistantEvent.Input | AssistantEvent.AppEvent) => Effect.Effect<void>
  readonly subscribe: (chatId: ChatId, after: number) => Stream.Stream<AssistantEvent.Entry>
}

const Submit = Rpc.make("Submit", {
  payload: { input: Schema.Union([AssistantEvent.Input, AssistantEvent.AppEvent]) }
}).annotate(ClusterSchema.Persisted, true)

const Subscribe = Rpc.make("Subscribe", {
  payload: { after: Schema.Int },
  success: AssistantEvent.Entry,
  stream: true
})

/**
 * Layer that runs chats as cluster entities, one per chat, keyed by chat id.
 * Needs `Sharding`: a `SingleRunner` for one process with SQL storage, or
 * `TestRunner` in tests.
 *
 * **Details**
 *
 * A chat's specialist runs live in its entity, which keeps itself alive
 * while they (or turns for their answers) work. A run cut off by a shutdown
 * answers that it was, and the entity starts again after the restart: when
 * an entity starts, it runs a turn for any input no turn has read. An entity
 * with no work and no subscribers stops after 5 minutes.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerCluster: Layer.Layer<AssistantEngine, never, ChatLog | Sharding.Sharding> = Layer.effect(
  AssistantEngine,
  Effect.gen(function* () {
    const context = yield* Effect.context<ChatLog | Sharding.Sharding>()
    const sharding = yield* Sharding.Sharding
    const clients = new Map<string, EntityClient>()

    const register = Effect.fn(function* (registration: Turns.Registration) {
      const ChatEntity = Entity.make(`Assistant/${registration.definition.name}`, [Submit, Subscribe])

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

        const chat = yield* Chat.makeChat({ registration, chatId, keepAlive })
        yield* chat.resume

        return ChatEntity.of({
          // The turns run inside the request, so a crash leaves it unprocessed and the cluster redelivers it.
          Submit: (request) => chat.submit(request.payload.input),
          Subscribe: (request) => chat.stream(request.payload.after)
        })
      })

      yield* sharding.registerEntity(ChatEntity, handlers.pipe(Effect.provide(context)), {
        maxIdleTime: "5 minutes",
        concurrency: "unbounded"
      })

      const makeClient = yield* ChatEntity.client

      clients.set(registration.definition.name, {
        submit: (chatId, input) => makeClient(chatId).Submit({ input }, { discard: true }).pipe(Effect.orDie),
        subscribe: (chatId, after) => makeClient(chatId).Subscribe({ after }).pipe(Stream.orDie)
      })
    })

    const clientOf = (assistant: string) => {
      const client = clients.get(assistant)

      return client === undefined ? notRegistered(assistant) : Effect.succeed(client)
    }

    return AssistantEngine.of({
      register: (registration) => register(registration).pipe(Effect.provide(context)),
      submit: (assistant, chatId, input) =>
        clientOf(assistant).pipe(Effect.flatMap((client) => client.submit(chatId, input))),
      subscribe: (assistant, chatId, after) =>
        Stream.unwrap(Effect.map(clientOf(assistant), (client) => client.subscribe(chatId, after)))
    })
  })
)
