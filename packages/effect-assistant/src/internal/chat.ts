/**
 * One chat of an assistant: its writer, its turns, and its specialist runs.
 * Both engines run chats with this.
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as PubSub from "effect/PubSub"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as SynchronizedRef from "effect/SynchronizedRef"
import { AssistantChat } from "../AssistantChat.ts"
import * as AssistantEvent from "../AssistantEvent.ts"
import type { ChatId } from "../ChatId.ts"
import { ChatLog } from "../ChatLog.ts"
import type { InputId } from "../InputId.ts"
import * as SpecialistService from "../Specialist.ts"
import * as Decisions from "./decisions.ts"
import * as AppEvents from "./events.ts"
import * as History from "./history.ts"
import * as Specialists from "./specialists.ts"
import * as Turns from "./turns.ts"

/** An input's id: the library's inputs have one, and the app's may. */
const idOf = (event: { readonly _tag: string }): string | undefined =>
  AssistantEvent.isLibraryEvent(event)
    ? AssistantEvent.isInput(event)
      ? event.id
      : undefined
    : Predicate.hasProperty(event, "id") && Predicate.isString(event.id)
      ? event.id
      : undefined

/** The chat's live entries, for its subscribers; shut down with the chat. */
const makeChannelPubSub = Effect.acquireRelease(PubSub.unbounded<AssistantEvent.Entry>(), PubSub.shutdown)

/**
 * Returns `holding`: runs an effect while holding the chat's keep-alive. The
 * first hold turns it on and the last one out turns it off. An effect that's
 * interrupted (a shutdown) keeps its hold, so the chat starts again and
 * picks up where it was cut off.
 */
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
      (_, exit) => (Exit.hasInterrupts(exit) ? Effect.void : release)
    )
})

/** One open chat of an assistant: what the engines do with it. */
export interface Chat {
  /** Stores the input, then runs turns until nothing is pending. */
  readonly submit: (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) => Effect.Effect<void>
  /** Stores the input, and runs turns for it in the background. */
  readonly submitInBackground: (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) => Effect.Effect<void>
  /**
   * Runs turns in the background for inputs no turn has read, like a report stored during a shutdown.
   */
  readonly resume: Effect.Effect<void>
  /**
   * The chat's entries after `after` (all of them by default), then new ones as they're appended.
   */
  readonly stream: (after: number) => Stream.Stream<AssistantEvent.Entry>
  /** Deletes the chat: its log, what works in it, and what it holds. */
  readonly delete: Effect.Effect<void>
}

/** A chat that was deleted: it takes nothing, and streams nothing. */
const deletedChat: Chat = {
  submit: () => Effect.void,
  submitInBackground: () => Effect.void,
  resume: Effect.void,
  stream: () => Stream.empty,
  delete: Effect.void
}

const refusedDeleted = (input: { readonly _tag: string }) =>
  Effect.logDebug(`assistant chat is deleted: ${input._tag} not stored`)

/**
 * Opens one chat of an assistant, in the current scope: runs the handlers'
 * builds, and returns how to submit to it and stream it.
 */
export const make = Effect.fnUntraced(function* (options: {
  readonly registration: Turns.Registration
  readonly chatId: ChatId
  readonly keepAlive: (enabled: boolean) => Effect.Effect<void>
}) {
  const { registration, chatId } = options
  const { app } = registration.definition
  const { wakes } = app
  const storage = yield* ChatLog

  if (yield* storage.isDeleted(chatId)) return deletedChat

  const channel = yield* makeChannelPubSub
  const writes = yield* Semaphore.make(1)
  // Inputs are stored one at a time, with the decisions they make: an answer checks the decisions the last one made.
  const storing = yield* Semaphore.make(1)
  const turnsLock = yield* Semaphore.make(1)
  const holding = yield* makeHolding(options.keepAlive)
  const deleted = yield* Deferred.make<undefined>()
  // What works in the chat, so deleting it stops all of it: its turns, runs, and the builds' resources.
  const working = yield* Scope.fork(yield* Effect.scope)
  const inWorking = Effect.provideService(Scope.Scope, working)
  const background = yield* inWorking(FiberSet.make())
  const requests = yield* inWorking(FiberSet.make())

  const isDeleted = Deferred.isDone(deleted)

  // The chat is its log's only writer, so it reads the log once and keeps the entries: a turn reads memory.
  const entries = yield* Ref.make(yield* storage.read(chatId))

  // Every writer (the turn's loop, specialist runs, a handler's own appends) goes through here, one at a time: each
  // append is numbered after the last, and its entries go to the chat's subscribers. After a delete it stores nothing.
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

  const chat = AssistantChat.of({
    chatId,
    entries: Ref.get(entries),
    append: (events) => Semaphore.withPermit(writes)(write(events))
  })

  /** Records what an answer decided: an approved call runs at the turn's next step. */
  const resolve = Effect.fnUntraced(function* (decided: ReadonlyArray<Decisions.Decided>, answer: InputId) {
    yield* chat.append(
      decided.map(({ request, outcome }) => AssistantEvent.DecisionResolved.make({ id: request.id, outcome, answer }))
    )
  })

  /**
   * Stores the input unless an input with its id is already stored, the chat is deleted, or the chat refuses it: a
   * decision answer that doesn't fit its block or what's still waiting. A decision answer's decisions are resolved
   * before the next input.
   */
  const store = Effect.fnUntraced(function* (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) {
    if (yield* isDeleted) return yield* refusedDeleted(input)

    // Checked under the write lock: a retry that arrives while the first submit is storing is stored once.
    const verdict = yield* Semaphore.withPermit(writes)(
      Effect.gen(function* () {
        if (yield* isDeleted) {
          yield* refusedDeleted(input)

          return Option.none()
        }

        const stored = yield* Ref.get(entries)
        const id = idOf(input)

        if (id !== undefined && stored.some(({ event }) => idOf(event) === id)) return Option.none()

        const verdict = Decisions.verdict(stored, input)

        if (Predicate.isTagged(verdict, "Refuse")) {
          yield* Effect.logWarning(`assistant chat refused ${input._tag}: ${verdict.reason}`)

          return Option.none()
        }

        yield* write([input])

        return Option.some(verdict)
      })
    )

    if (Option.isSome(verdict) && Predicate.isTagged(verdict.value, "Decide")) {
      yield* resolve(verdict.value.decided, verdict.value.answer)
    }
  }, Semaphore.withPermit(storing))

  // A restart between storing an answer and resolving it: resolve it now, before anything reads the chat.
  yield* Effect.forEach(
    Decisions.unresolved(yield* Ref.get(entries)),
    (decided) => resolve([decided], decided.answer),
    { discard: true }
  )

  // The handlers' builds run now, in the chat's working scope: what they set up lives until the chat closes or is
  // deleted.
  const handler = yield* inWorking(Effect.provideService(registration.open, AssistantChat, chat))

  const specialists = yield* Effect.forEach(
    registration.specialists,
    Effect.fnUntraced(function* ({ specialist, built }) {
      const handler = yield* inWorking(Effect.provideService(built.open, AssistantChat, chat))

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

  /** Runs turns, one at a time, until no input is left unhandled. */
  const drain: Effect.Effect<void> = Semaphore.withPermit(turnsLock)(
    Effect.gen(function* () {
      while (!(yield* isDeleted) && History.needsTurn(yield* chat.entries, wakes)) {
        yield* Turns.run({ registration, handler, chat, services })
      }
    })
  )

  const runner = yield* inWorking(
    Specialists.makeRunner({
      chat,
      specialists,
      model: registration.model,
      holding,
      report: Effect.fnUntraced(function* (finished) {
        yield* store(finished)
        yield* inBackground(drain)
      })
    })
  )

  const services = Context.make(AssistantChat, chat).pipe(
    Context.add(SpecialistService.Runner, runner),
    Context.add(
      Decisions.TurnDecisions,
      Option.some({
        approved: Effect.gen(function* () {
          const all = yield* chat.entries

          return Decisions.approvedCalls(all)
        })
      })
    ),
    Context.merge(registration.model)
  )

  const remove = Effect.gen(function* () {
    // Under the write lock: an append in flight is stored, and deleted with the rest; none comes after.
    const first = yield* Semaphore.withPermit(writes)(
      Effect.gen(function* () {
        if (yield* isDeleted) return false

        yield* storage.delete(chatId)
        yield* Ref.set(entries, [])

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
      if (History.needsTurn(yield* chat.entries, wakes)) yield* inBackground(drain)
    }),
    stream: (after) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (yield* isDeleted) return Stream.empty

          // Subscribes before it reads, so nothing appended in between is missed.
          const subscription = yield* PubSub.subscribe(channel)
          const stored = (yield* chat.entries).filter((entry) => entry.seq > after)
          const last = stored.at(-1)?.seq ?? after

          return Stream.concat(
            Stream.fromIterable(stored),
            Stream.fromSubscription(subscription).pipe(Stream.filter((entry) => entry.seq > last))
          ).pipe(Stream.interruptWhen(Deferred.await(deleted)))
        })
      ),
    delete: remove
  }

  return chatApi
})
