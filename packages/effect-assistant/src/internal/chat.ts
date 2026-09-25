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
import * as SpecialistService from "../Specialist.ts"
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
  const { inputs } = registration.definition.app
  const storage = yield* ChatLog
  const channel = yield* makeChannelPubSub
  const writes = yield* Semaphore.make(1)
  const turnsLock = yield* Semaphore.make(1)
  const holding = yield* makeHolding(options.keepAlive)
  const background = yield* FiberSet.make()

  // The chat is its log's only writer, so it reads the log once and keeps the entries: a turn reads memory.
  const entries = yield* Ref.make(yield* storage.read(chatId))

  // Every writer (the turn's loop, specialist runs, a handler's own appends) goes through here, one at a time: each
  // append is numbered after the last, and its entries go to the chat's subscribers.
  const chat = AssistantChat.of({
    chatId,
    entries: Ref.get(entries),
    append: (events) =>
      storage.append(chatId, events).pipe(
        Effect.tap((stored) => Ref.update(entries, (all) => [...all, ...stored])),
        Effect.tap((stored) => PubSub.publishAll(channel, stored)),
        Semaphore.withPermit(writes)
      )
  })

  /** Stores the input unless an input with its id is already stored. */
  const store = Effect.fn(function* (input: AssistantEvent.Input | AssistantEvent.AppEvent) {
    const id = idOf(input)
    const stored = yield* chat.entries

    if (id === undefined || !stored.some(({ event }) => idOf(event) === id)) yield* chat.append([input])
  })

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
      while (History.needsTurn(yield* chat.entries, inputs)) {
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
    Context.merge(registration.model)
  )

  return {
    /** Stores the input, then runs turns until nothing is pending. */
    submit: (input: AssistantEvent.Input | AssistantEvent.AppEvent) => store(input).pipe(Effect.andThen(drain)),
    /** Stores the input, and runs turns for it in the background. */
    submitInBackground: (input: AssistantEvent.Input | AssistantEvent.AppEvent) =>
      store(input).pipe(Effect.andThen(inBackground(drain))),
    /** Runs turns in the background for inputs no turn has read, like a report stored during a shutdown. */
    resume: Effect.gen(function* () {
      if (History.needsTurn(yield* chat.entries, inputs)) yield* inBackground(drain)
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
