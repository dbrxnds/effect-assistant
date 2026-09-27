/**
 * One chat of an assistant: its writer, its turns, and its specialist runs.
 * Both engines run chats with this.
 *
 * @since 0.1.0
 * @internal
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
import * as Decision from "../Decision.ts"
import type { InputId } from "../InputId.ts"
import * as SpecialistService from "../Specialist.ts"
import { Composer } from "./composing.ts"
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

/** Whether an input is a workflow's decision: the answer completes its deferred, which takes a workflow engine. */
const needsWorkflows = (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) =>
  AssistantEvent.isLibraryEvent(input) &&
  Predicate.isTagged(input, "DecisionRequested") &&
  Predicate.isTagged(input.origin, "Work") &&
  input.origin.token !== undefined

const noWorkflows = (request: { readonly _tag: string }) =>
  `A workflow's ${request._tag} needs the WorkflowEngine to pass the answer on: provide it to the assistant's layer.`

/** The chat's live entries, and what the assistant composes, for its subscribers; shut down with the chat. */
const makeChannelPubSub = Effect.acquireRelease(
  PubSub.unbounded<AssistantEvent.Entry | AssistantEvent.Composing>(),
  PubSub.shutdown
)

/**
 * Returns `holding`: runs an effect while holding the chat's keep-alive. The
 * first hold turns it on and the last one out turns it off. An effect that's
 * interrupted (a shutdown) keeps its hold, so the chat starts again and
 * picks up where it was cut off.
 */
const makeHolding = Effect.fn(function* (keepAlive: (enabled: boolean) => Effect.Effect<void>) {
  const holds = yield* SynchronizedRef.make(0)

  const acquire = SynchronizedRef.updateEffect(holds, (n) =>
    n === 0 ? Effect.as(keepAlive(true), 1) : Effect.succeed(n + 1)
  )

  const release = SynchronizedRef.updateEffect(holds, (n) =>
    n === 1 ? Effect.as(keepAlive(false), 0) : Effect.succeed(n - 1)
  )

  return (effect: Effect.Effect<void>) =>
    Effect.acquireUseRelease(
      acquire,
      () => effect,
      (_, exit) => (Exit.hasInterrupts(exit) ? Effect.void : release)
    )
})

/**
 * One open chat of an assistant: what the engines do with it.
 *
 * @internal
 */
export interface Chat {
  /** Stores the input, then runs turns until nothing is pending. */
  readonly submit: (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) => Effect.Effect<void>
  /** Stores the input, and runs turns for it in the background. */
  readonly submitInBackground: (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) => Effect.Effect<void>
  /** Runs turns in the background for inputs no turn has read, like a report stored during a shutdown. */
  readonly resume: Effect.Effect<void>
  /**
   * The chat's entries after `after` (all of them by default), then new ones as they're appended, with what the
   * assistant composes in between.
   */
  readonly stream: (after: number) => Stream.Stream<AssistantEvent.Entry | AssistantEvent.Composing>
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
 *
 * **Details**
 *
 * `submit` stores an input and runs turns until nothing is pending;
 * `submitInBackground` returns once the input is stored. A run's report is
 * stored and gets a turn in the background, like an input. Turns run one at
 * a time, and the chat's writes go one at a time through its
 * `AssistantChat`, which also sends them to its subscribers.
 *
 * `keepAlive` is on while anything works in the background: a run, or turns
 * no request waits on.
 *
 * Everything that works in the chat (the builds' resources, turns, runs)
 * lives in a scope of its own, which `delete` closes: after it, the chat
 * stores nothing, and what reported into it finds it gone, quietly. A chat
 * deleted before it opened takes nothing.
 *
 * @internal
 */
export const makeChat = Effect.fn(function* (options: {
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
  const deleted = yield* Deferred.make<void>()
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
  const write = (events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>) => {
    const unknown = events.find((event) => !AssistantEvent.isLibraryEvent(event) && !AppEvents.isRegistered(app, event))

    return unknown === undefined
      ? Effect.flatMap(isDeleted, (gone) => (gone ? Effect.succeed([]) : stored(events)))
      : Effect.die(`${unknown._tag} isn't one of the ${registration.definition.name} assistant's events.`)
  }

  // Uninterruptible: a stored append must reach memory and the subscribers too, or a turn misses it and replies twice.
  const stored = (events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>) =>
    storage.append(chatId, events).pipe(
      Effect.tap((stored) => Ref.update(entries, (all) => [...all, ...stored])),
      Effect.tap((stored) => PubSub.publishAll(channel, stored)),
      Effect.uninterruptible
    )

  // What the assistant composes now, so subscribers hear only a change.
  const composing = yield* Ref.make<string | undefined>(undefined)

  const compose = (next: AssistantEvent.Composing) =>
    Ref.getAndSet(composing, next.text).pipe(
      Effect.flatMap((last) => (last === next.text ? Effect.void : PubSub.publish(channel, next))),
      Effect.asVoid
    )

  const chat = AssistantChat.of({
    chatId,
    entries: Ref.get(entries),
    append: (events) => Semaphore.withPermit(writes)(write(events))
  })

  /** Passes a workflow's decision on: completes the deferred it waits on. */
  const deliver = ({ request, outcome }: Decisions.Decided) => {
    const { origin } = request

    if (!Predicate.isTagged(origin, "Work") || origin.token === undefined) return Effect.void

    const token = origin.token

    return Option.match(registration.workflows, {
      onNone: () => Effect.die(noWorkflows(request)),
      onSome: (workflows) => Effect.provideContext(Decisions.complete(token, outcome), workflows)
    })
  }

  /** Records what an answer decided, once any workflow waiting on it has it. */
  const resolve = Effect.fn(function* (decided: ReadonlyArray<Decisions.Decided>, answer: InputId) {
    yield* Effect.forEach(decided, deliver, { discard: true })
    yield* chat.append(
      decided.map(({ request, outcome }) => AssistantEvent.DecisionResolved.make({ id: request.id, outcome, answer }))
    )
  })

  /**
   * Stores the input unless an input with its id is already stored, the chat is deleted, or the chat refuses it: a
   * decision answer that doesn't fit its block or what's still waiting. A decision answer's decisions are resolved
   * before the next input.
   */
  const store = Effect.fn(function* (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) {
    if (yield* isDeleted) return yield* refusedDeleted(input)

    if (needsWorkflows(input) && Option.isNone(registration.workflows)) return yield* Effect.die(noWorkflows(input))

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

  const specialists = yield* Effect.forEach(registration.specialists, ({ specialist, built }) =>
    Effect.map(inWorking(Effect.provideService(built.open, AssistantChat, chat)), (runHandler) => ({
      specialist,
      handler: runHandler
    }))
  )

  const inBackground = (effect: Effect.Effect<void>) => FiberSet.run(background, holding(effect)).pipe(Effect.asVoid)

  // A request's turns run in the working scope too, so a delete stops them; the request ends quietly then.
  const inRequest = (effect: Effect.Effect<void>) =>
    FiberSet.run(requests, effect).pipe(
      Effect.flatMap((fiber) => Fiber.await(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))),
      Effect.flatMap((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? Effect.failCause(exit.cause) : Effect.void
      ),
      Effect.orDie
    )

  /** Runs turns, one at a time, until no input is left unhandled. */
  const drain: Effect.Effect<void> = Semaphore.withPermit(turnsLock)(
    Effect.gen(function* () {
      while (!(yield* isDeleted) && History.needsTurn(yield* chat.entries, wakes)) {
        yield* Turns.runTurn({ registration, handler, chat, services })
      }
    })
  )

  const runner = yield* inWorking(
    Specialists.makeRunner({
      chat,
      specialists,
      model: registration.model,
      holding,
      report: (finished) => store(finished).pipe(Effect.andThen(inBackground(drain)))
    })
  )

  const services = Context.make(AssistantChat, chat).pipe(
    Context.add(SpecialistService.Runner, runner),
    Context.add(Decisions.TurnDecisions, Option.some({ approved: Effect.map(chat.entries, Decisions.approvedCalls) })),
    Context.add(Composer, compose),
    Context.merge(registration.model)
  )

  /** Declines what workflows still wait on: no one can answer them now, and declining runs nothing. */
  const declineWaiting = Effect.gen(function* () {
    if (Option.isNone(registration.workflows)) return

    const waiting = [...Decision.states(yield* Ref.get(entries)).values()].filter(
      ({ request, outcome }) =>
        outcome === undefined && Predicate.isTagged(request.origin, "Work") && request.origin.token !== undefined
    )

    yield* Effect.forEach(waiting, ({ request }) => deliver({ request, outcome: "declined" }), { discard: true })
  })

  const remove = Effect.gen(function* () {
    // Under the write lock: an append in flight is stored, and deleted with the rest; none comes after.
    const first = yield* Semaphore.withPermit(writes)(
      Effect.gen(function* () {
        if (yield* isDeleted) return false

        yield* declineWaiting
        yield* storage.delete(chatId)
        yield* Ref.set(entries, [])

        return yield* Deferred.succeed(deleted, undefined)
      })
    ).pipe(Effect.uninterruptible)

    if (!first) return

    // Its own fiber: a tool that deletes its own chat is in the working scope, and closing it interrupts that tool.
    // Interrupted work keeps its hold (see `makeHolding`), so the chat lets go of it here.
    const closing = yield* Effect.forkDetach(
      Scope.close(working, Exit.void).pipe(Effect.andThen(options.keepAlive(false)))
    )

    yield* Fiber.await(closing)
  })

  const chatApi: Chat = {
    submit: (input) => store(input).pipe(Effect.andThen(inRequest(drain))),
    submitInBackground: (input) => store(input).pipe(Effect.andThen(inBackground(drain))),
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
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((live) => Predicate.isTagged(live, "Composing") || live.seq > last)
            )
          ).pipe(Stream.interruptWhen(Deferred.await(deleted)))
        })
      ),
    delete: remove
  }

  return chatApi
})
