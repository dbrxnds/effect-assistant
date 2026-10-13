import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import * as Predicate from "effect/Predicate"
import * as PubSub from "effect/PubSub"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as SynchronizedRef from "effect/SynchronizedRef"
import * as AssistantEvent from "../AssistantEvent.ts"
import type { ChatId } from "../ChatId.ts"
import { ChatLog } from "../ChatLog.ts"
import { CurrentChat } from "../CurrentChat.ts"
import * as Chats from "../Chats.ts"
import * as SpecialistService from "../Specialist.ts"
import * as ToolApproval from "../ToolApproval.ts"
import * as AppEvents from "./events.ts"
import * as History from "./history.ts"
import * as Specialists from "./specialists.ts"
import * as Turns from "./turns.ts"
import type { Writer } from "./writer.ts"

const idOf = (event: { readonly _tag: string }): string | undefined =>
  AssistantEvent.isLibraryEvent(event)
    ? AssistantEvent.isInput(event)
      ? event.id
      : undefined
    : Predicate.hasProperty(event, "id") && Predicate.isString(event.id)
      ? event.id
      : undefined

const makeChannelPubSub = Effect.acquireRelease(PubSub.unbounded<AssistantEvent.Entry>(), PubSub.shutdown)

const makeHolding = Effect.fnUntraced(function* (keepAlive: (enabled: boolean) => Effect.Effect<void>) {
  const holds = yield* SynchronizedRef.make(0)

  const acquire = SynchronizedRef.updateEffect(
    holds,
    Effect.fnUntraced(function* (n: number) {
      if (n !== 0) return n + 1

      yield* keepAlive(true)

      return 1
    })
  )

  const release = SynchronizedRef.updateEffect(
    holds,
    Effect.fnUntraced(function* (n: number) {
      if (n !== 1) return n - 1

      yield* keepAlive(false)

      return 0
    })
  )

  return (effect: Effect.Effect<void>) =>
    Effect.acquireUseRelease(
      acquire,
      () => effect,
      // An interrupted effect (a shutdown) keeps its hold, so the chat starts again and picks up where it was cut off.
      (_, exit) => (Exit.hasInterrupts(exit) ? Effect.void : release)
    )
})

/** @internal */
export interface Chat {
  readonly submit: (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) => Effect.Effect<void>
  readonly submitInBackground: (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) => Effect.Effect<void>
  // For inputs no turn has read, like a report stored during a shutdown.
  readonly resume: Effect.Effect<void>
  readonly stream: (after: number) => Stream.Stream<AssistantEvent.Entry>
  // Stops what works in the chat and ends its subscribers' streams; its log stays.
  readonly delete: Effect.Effect<void>
}

const isChatDeleted = (entry: AssistantEvent.Entry) => Predicate.isTagged(entry.event, "ChatDeleted")

const deletedChat = (entries: ReadonlyArray<AssistantEvent.Entry>): Chat => ({
  submit: () => Effect.void,
  submitInBackground: () => Effect.void,
  resume: Effect.void,
  stream: (after) => Stream.fromIterable(entries.filter((entry) => entry.seq > after)),
  delete: Effect.void
})

const refused = (input: { readonly _tag: string }, why: string) =>
  Effect.logDebug(`assistant chat ${why}: ${input._tag} not stored`)

/** @internal */
export const make = Effect.fnUntraced(function* (options: {
  readonly registration: Turns.Registration
  readonly chatId: ChatId
  readonly keepAlive: (enabled: boolean) => Effect.Effect<void>
}) {
  const { registration, chatId } = options
  const { app } = registration.definition
  const storage = yield* ChatLog
  const chats = yield* Chats.Chats
  const initial = yield* storage.read(chatId)

  if (initial.some(isChatDeleted)) return deletedChat(initial)

  const channel = yield* makeChannelPubSub
  const writes = yield* Semaphore.make(1)
  const turnsLock = yield* Semaphore.make(1)
  const holding = yield* makeHolding(options.keepAlive)
  const deleted = yield* Deferred.make<undefined>()
  // So deleting the chat stops all its work: its turns, runs, and the builds' resources.
  const working = yield* Scope.fork(yield* Effect.scope)
  const inWorking = Effect.provideService(Scope.Scope, working)
  const background = yield* inWorking(FiberSet.make())
  const requests = yield* inWorking(FiberSet.make())

  const isDeleted = Deferred.isDone(deleted)

  // The chat is its log's only writer, so it reads the log once and turns read memory.
  const entries = yield* Ref.make(initial)

  // Every writer goes through here, one at a time, so each append is numbered after the last. After a delete it
  // stores nothing.
  const write = Effect.fnUntraced(function* (
    events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>
  ) {
    const unknown = events.find((event) => !AssistantEvent.isLibraryEvent(event) && !AppEvents.isRegistered(app, event))

    if (unknown !== undefined) {
      return yield* Effect.die(`${unknown._tag} isn't one of the ${registration.definition.name} assistant's events.`)
    }

    if (yield* isDeleted) return []

    return yield* stored(events)
  })

  // Uninterruptible: a stored append must reach memory and the subscribers too, or a turn misses it and replies twice.
  const stored = Effect.fnUntraced(function* (
    events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>
  ) {
    const stored = yield* storage.append(chatId, events)

    yield* Ref.update(entries, (all) => [...all, ...stored])
    yield* PubSub.publishAll(channel, stored)

    return stored
  }, Effect.uninterruptible)

  const chat: Writer = {
    chatId,
    entries: Ref.get(entries),
    append: (events) => Semaphore.withPermit(writes)(write(events))
  }

  const toStored = (event: {
    readonly _tag: string
  }): Effect.Effect<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent> =>
    AssistantEvent.isLibraryEvent(event)
      ? Effect.succeed(event)
      : AppEvents.isRegistered(app, event)
        ? AppEvents.encode(app, event)
        : Effect.die(`${event._tag} isn't one of the ${registration.definition.name} assistant's events.`)

  // What handlers, tools, and runs see: the assistant's own events decoded, and encoded when appended.
  const handle: Turns.TypedChat = {
    chatId,
    entries: Effect.map(chat.entries, (all) => AppEvents.decodeEntries(app, all)),
    append: (...events) => Effect.asVoid(Effect.flatMap(Effect.forEach(events, toStored), chat.append))
  }

  // A chat the app deleted is deleted here too, which stops what works in it: a turn that checks stops there.
  const checkAvailable: Effect.Effect<boolean> = chats.get(chatId).pipe(
    Effect.as(true),
    Effect.catchTag("GetChatError", (unavailable) =>
      unavailable.reason === "Deleted"
        ? Effect.as(
            Effect.suspend(() => remove),
            false
          )
        : Effect.succeed(false)
    )
  )

  const store = Effect.fnUntraced(function* (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) {
    if (yield* isDeleted) return yield* refused(input, "is deleted")

    if (!(yield* checkAvailable)) return yield* refused(input, "is unavailable")

    // Checked under the write lock: a retry that arrives while the first submit is storing is stored once.
    yield* Semaphore.withPermit(writes)(
      Effect.gen(function* () {
        if (yield* isDeleted) return yield* refused(input, "is deleted")

        const id = idOf(input)
        const all = yield* Ref.get(entries)

        if (id !== undefined && all.some(({ event }) => idOf(event) === id)) return

        // A decision counts only for a call that still waits: not one decided, or expired, or unknown.
        if (
          Predicate.isTagged(input, "ApprovalDecision") &&
          ToolApproval.fromEntries(all).get(input.callId)?.status !== "pending"
        ) {
          return yield* refused(input, "has no call waiting for that decision")
        }

        // Stored as an input: it came in from outside a turn, so it wakes one, also after a restart.
        yield* write([AssistantEvent.isLibraryEvent(input) ? input : AppEvents.markInput(input)])
      })
    )
  })

  // The handlers' builds run in the chat's working scope: what they set up lives until the chat closes or is deleted.
  const handler = yield* inWorking(Effect.provideService(registration.open(handle), CurrentChat, handle))

  const specialists = yield* Effect.forEach(
    registration.specialists,
    Effect.fnUntraced(function* ({ specialist, built }) {
      const handler = yield* inWorking(Effect.provideService(built.open, CurrentChat, handle))

      return { specialist, handler }
    })
  )

  const inBackground = (effect: Effect.Effect<void>) => FiberSet.run(background, holding(effect)).pipe(Effect.asVoid)

  // A request's turns run in the working scope too, so a delete stops them; the request ends quietly then.
  const inRequest = Effect.fnUntraced(function* (effect: Effect.Effect<void>) {
    const fiber = yield* FiberSet.run(requests, effect)
    const exit = yield* Fiber.await(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))

    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      return yield* Effect.failCause(exit.cause)
    }
  }, Effect.orDie)

  const drain: Effect.Effect<void> = Semaphore.withPermit(turnsLock)(
    Effect.gen(function* () {
      while (!(yield* isDeleted) && History.needsTurn(yield* chat.entries)) {
        yield* Turns.run({ registration, handler, chat, services, checkOpen: Effect.asVoid(checkAvailable) })
      }
    })
  )

  const runner = yield* inWorking(
    Specialists.makeRunner({
      chat,
      handle,
      specialists,
      model: registration.model,
      holding,
      report: Effect.fnUntraced(function* (finished) {
        yield* store(finished)
        yield* inBackground(drain)
      })
    })
  )

  const services = Context.make(CurrentChat, handle).pipe(
    Context.add(SpecialistService.Runner, runner),
    Context.merge(registration.model)
  )

  const remove = Effect.gen(function* () {
    // Under the write lock: an append in flight is stored before the `ChatDeleted`; none comes after.
    const first = yield* Semaphore.withPermit(writes)(
      Effect.gen(function* () {
        if (yield* isDeleted) return false

        yield* stored([AssistantEvent.ChatDeleted.make({})])

        return yield* Deferred.succeed(deleted, undefined)
      })
    ).pipe(Effect.uninterruptible)

    if (!first) return

    // Its own fiber: a tool that deletes its own chat is in the working scope, and closing it interrupts that tool.
    // Interrupted work keeps its hold (see `makeHolding`), so the chat lets go of it here.
    const closing = yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Scope.close(working, Exit.void)
        yield* options.keepAlive(false)
      })
    )

    yield* Fiber.await(closing)
  })

  // A chat the app deleted while it was closed is deleted now, so its subscribers hear it.
  yield* checkAvailable

  const chatApi: Chat = {
    submit: Effect.fnUntraced(function* (input) {
      yield* store(input)
      yield* inRequest(drain)
    }),
    submitInBackground: Effect.fnUntraced(function* (input) {
      yield* store(input)
      yield* inBackground(drain)
    }),
    resume: Effect.gen(function* () {
      if (History.needsTurn(yield* chat.entries)) yield* inBackground(drain)
    }),
    stream: (after) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribes before it reads, so nothing appended in between is missed.
          const subscription = yield* PubSub.subscribe(channel)
          const all = yield* chat.entries
          const stored = all.filter((entry) => entry.seq > after)
          const last = stored.at(-1)?.seq ?? after

          // Deleted: what the reader hasn't seen, then the end. Otherwise the stream ends with the `ChatDeleted`.
          if (all.some(isChatDeleted)) return Stream.fromIterable(stored)

          return Stream.concat(
            Stream.fromIterable(stored),
            Stream.fromSubscription(subscription).pipe(Stream.filter((entry) => entry.seq > last))
          ).pipe(Stream.takeUntil(isChatDeleted))
        })
      ),
    delete: remove
  }

  return chatApi
})
