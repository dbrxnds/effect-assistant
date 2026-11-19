import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SynchronizedRef from "effect/SynchronizedRef"
import * as ChatSignal from "../ChatSignal.ts"

interface Labelled {
  readonly callId: string
  readonly text: string
}

/** @internal */
export interface State {
  /** The described calls still running, oldest first. */
  readonly running: ReadonlyArray<Labelled>
  /** The line the user sees; none before the first status and after typing started. */
  readonly shown: string | undefined
  /** When the line last changed, or the turn started, in epoch milliseconds. */
  readonly shownAt: number
  /** Every line the turn showed, oldest first. */
  readonly lines: ReadonlyArray<string>
  readonly typing: boolean
}

/** @internal */
export interface Live {
  readonly callStarted: (callId: string, text: string) => Effect.Effect<void>
  readonly callEnded: (callId: string) => Effect.Effect<void>
  // A summary's line: shown unless the model started a message, or the line says it already.
  readonly summarized: (text: string) => Effect.Effect<void>
  readonly typing: (typing: boolean) => Effect.Effect<void>
  readonly state: Effect.Effect<State>
  // The turn ends: typing stops. Its end, in the log, clears the line.
  readonly reset: Effect.Effect<void>
}

// A turn's own: a specialist's run, or a loop outside a turn, shows nothing.
/** @internal */
export const TurnLive = Context.Reference<Option.Option<Live>>("effect-assistant/TurnLive", {
  defaultValue: Option.none
})

/** @internal */
export const use = Effect.fnUntraced(function* (f: (live: Live) => Effect.Effect<void>) {
  const live = yield* TurnLive

  if (Option.isSome(live)) yield* f(live.value)
})

type Change = readonly [ReadonlyArray<ChatSignal.ChatSignal>, State] | undefined

/** @internal */
export const make = Effect.fnUntraced(function* (send: (signal: ChatSignal.ChatSignal) => Effect.Effect<void>) {
  const state = yield* SynchronizedRef.make<State>({
    running: [],
    shown: undefined,
    shownAt: yield* Clock.currentTimeMillis,
    lines: [],
    typing: false
  })

  // Under the ref's lock, so signals go out in the order the state changed.
  const change = (f: (current: State, now: number) => Change) =>
    SynchronizedRef.updateEffect(
      state,
      Effect.fnUntraced(function* (current) {
        const changed = f(current, yield* Clock.currentTimeMillis)

        if (changed === undefined) return current

        const [signals, next] = changed

        yield* Effect.forEach(signals, send, { discard: true })

        return next
      })
    )

  const show = (current: State, text: string, now: number): readonly [ReadonlyArray<ChatSignal.ChatSignal>, State] =>
    current.shown === text
      ? [[], current]
      : [[ChatSignal.Status.make({ text })], { ...current, shown: text, shownAt: now, lines: [...current.lines, text] }]

  const live: Live = {
    callStarted: (callId, text) =>
      change((current, now) => {
        const running = { ...current, running: [...current.running, { callId, text }] }

        return current.typing ? [[], running] : show(running, text, now)
      }),
    // The line stays when the last labelled call ends; while another runs, the line says that one.
    callEnded: (callId) =>
      change((current, now) => {
        const ended = current.running.find((call) => call.callId === callId)

        if (ended === undefined) return undefined

        const next = { ...current, running: current.running.filter((call) => call.callId !== callId) }
        const still = next.running.at(-1)

        return still === undefined || current.typing || current.shown !== ended.text
          ? [[], next]
          : show(next, still.text, now)
      }),
    summarized: (text) =>
      change((current, now) =>
        current.typing
          ? undefined
          : current.shown === text
            ? [[], { ...current, shownAt: now }]
            : show(current, text, now)
      ),
    typing: (typing) =>
      change((current, now) => {
        if (current.typing === typing) return undefined

        if (typing) {
          return [[ChatSignal.TypingStarted.make({})], { ...current, typing, shown: undefined, shownAt: now }]
        }

        // A call that runs on after the message still says what it does.
        const stopped = { ...current, typing, shownAt: now }
        const still = current.running.at(-1)
        const [signals, next] = still === undefined ? [[], stopped] : show(stopped, still.text, now)

        return [[ChatSignal.TypingStopped.make({}), ...signals], next]
      }),
    state: SynchronizedRef.get(state),
    reset: change((current) =>
      current.typing ? [[ChatSignal.TypingStopped.make({})], { ...current, typing: false }] : undefined
    )
  }

  return live
})
