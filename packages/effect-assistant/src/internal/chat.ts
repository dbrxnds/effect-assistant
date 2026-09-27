/**
 * One chat of an assistant: its writer, its turns, and its specialist runs.
 * Both engines run chats with this.
 *
 * @since 0.1.0
 * @internal
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberSet from "effect/FiberSet"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as PubSub from "effect/PubSub"
import * as Ref from "effect/Ref"
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

/** Whether an input is a workflow's decision: the answer completes its deferred, which takes a workflow engine. */
const needsWorkflows = (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) =>
  AssistantEvent.isLibraryEvent(input) &&
  Predicate.isTagged(input, "DecisionRequested") &&
  Predicate.isTagged(input.origin, "Work") &&
  input.origin.token !== undefined

const noWorkflows = (request: { readonly _tag: string }) =>
  `A workflow's ${request._tag} needs the WorkflowEngine to pass the answer on: provide it to the assistant's layer.`

/** The chat's live entries, for its subscribers; shut down with the chat. */
const makeChannelPubSub = Effect.acquireRelease(PubSub.unbounded<AssistantEvent.Entry>(), PubSub.shutdown)

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
  const channel = yield* makeChannelPubSub
  const writes = yield* Semaphore.make(1)
  // Inputs are stored one at a time, with the decisions they make: an answer checks the decisions the last one made.
  const storing = yield* Semaphore.make(1)
  const turnsLock = yield* Semaphore.make(1)
  const holding = yield* makeHolding(options.keepAlive)
  const background = yield* FiberSet.make()

  // The chat is its log's only writer, so it reads the log once and keeps the entries: a turn reads memory.
  const entries = yield* Ref.make(yield* storage.read(chatId))

  // Every writer (the turn's loop, specialist runs, a handler's own appends) goes through here, one at a time: each
  // append is numbered after the last, and its entries go to the chat's subscribers.
  // Uninterruptible: a stored append must reach memory and the subscribers too, or a turn misses it and replies twice.
  const write = (events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>) => {
    const unknown = events.find((event) => !AssistantEvent.isLibraryEvent(event) && !AppEvents.isRegistered(app, event))

    return unknown === undefined
      ? stored(events)
      : Effect.die(`${unknown._tag} isn't one of the ${registration.definition.name} assistant's events.`)
  }

  const stored = (events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>) =>
    storage.append(chatId, events).pipe(
      Effect.tap((stored) => Ref.update(entries, (all) => [...all, ...stored])),
      Effect.tap((stored) => PubSub.publishAll(channel, stored)),
      Effect.uninterruptible
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
   * Stores the input unless an input with its id is already stored, or the chat refuses it: a decision answer that
   * doesn't fit its block or what's still waiting. A decision answer's decisions are resolved before the next input.
   */
  const store = Effect.fn(function* (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) {
    if (needsWorkflows(input) && Option.isNone(registration.workflows)) return yield* Effect.die(noWorkflows(input))

    // Checked under the write lock: a retry that arrives while the first submit is storing is stored once.
    const verdict = yield* Semaphore.withPermit(writes)(
      Effect.gen(function* () {
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

  // The handlers' builds run now, in the chat's scope: what they set up lives while the chat does.
  const handler = yield* Effect.provideService(registration.open, AssistantChat, chat)

  const specialists = yield* Effect.forEach(registration.specialists, ({ specialist, built }) =>
    Effect.map(Effect.provideService(built.open, AssistantChat, chat), (runHandler) => ({
      specialist,
      handler: runHandler
    }))
  )

  const inBackground = (effect: Effect.Effect<void>) => FiberSet.run(background, holding(effect)).pipe(Effect.asVoid)

  /** Runs turns, one at a time, until no input is left unhandled. */
  const drain: Effect.Effect<void> = Semaphore.withPermit(turnsLock)(
    Effect.gen(function* () {
      while (History.needsTurn(yield* chat.entries, wakes)) {
        yield* Turns.runTurn({ registration, handler, chat, services })
      }
    })
  )

  const runner = yield* Specialists.makeRunner({
    chat,
    specialists,
    model: registration.model,
    holding,
    report: (finished) => store(finished).pipe(Effect.andThen(inBackground(drain)))
  })

  const services = Context.make(AssistantChat, chat).pipe(
    Context.add(SpecialistService.Runner, runner),
    Context.add(Decisions.TurnDecisions, Option.some({ approved: Effect.map(chat.entries, Decisions.approvedCalls) })),
    Context.merge(registration.model)
  )

  return {
    /** Stores the input, then runs turns until nothing is pending. */
    submit: (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) => store(input).pipe(Effect.andThen(drain)),
    /** Stores the input, and runs turns for it in the background. */
    submitInBackground: (input: AssistantEvent.Input | AssistantEvent.StoredAppEvent) =>
      store(input).pipe(Effect.andThen(inBackground(drain))),
    /** Runs turns in the background for inputs no turn has read, like a report stored during a shutdown. */
    resume: Effect.gen(function* () {
      if (History.needsTurn(yield* chat.entries, wakes)) yield* inBackground(drain)
    }),
    /** The chat's entries after `after` (all of them by default), then new ones as they're appended. */
    stream: (after: number) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribes before it reads, so nothing appended in between is missed.
          const subscription = yield* PubSub.subscribe(channel)
          const stored = (yield* chat.entries).filter((entry) => entry.seq > after)
          const last = stored.at(-1)?.seq ?? after

          return Stream.concat(
            Stream.fromIterable(stored),
            Stream.fromSubscription(subscription).pipe(Stream.filter((entry) => entry.seq > last))
          )
        })
      )
  }
})

/** @internal */
export type Chat = Effect.Success<ReturnType<typeof makeChat>>
