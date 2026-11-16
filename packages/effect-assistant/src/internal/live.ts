import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SynchronizedRef from "effect/SynchronizedRef"
import * as ChatSignal from "../ChatSignal.ts"

/** @internal */
export const summaryKey = "summary"

/** @internal */
export interface State {
  readonly statuses: ReadonlyMap<string, ChatSignal.StatusShown>
  readonly typing: boolean
  /** When anything was last shown or cleared, in epoch milliseconds. */
  readonly changedAt: number
}

/** @internal */
export interface Live {
  readonly show: (key: string, text: string, source: ChatSignal.StatusSource) => Effect.Effect<void>
  readonly clear: (key: string) => Effect.Effect<void>
  readonly typing: (typing: boolean) => Effect.Effect<void>
  readonly state: Effect.Effect<State>
  // Clears everything still shown: a turn ends with nothing showing.
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

/** @internal */
export const make = Effect.fnUntraced(function* (send: (signal: ChatSignal.ChatSignal) => Effect.Effect<void>) {
  const state = yield* SynchronizedRef.make<State>({
    statuses: new Map(),
    typing: false,
    changedAt: yield* Clock.currentTimeMillis
  })

  // Under the ref's lock, so signals go out in the order the state changed.
  const change = (f: (current: State) => readonly [ReadonlyArray<ChatSignal.ChatSignal>, State] | undefined) =>
    SynchronizedRef.updateEffect(
      state,
      Effect.fnUntraced(function* (current) {
        const changed = f(current)

        if (changed === undefined) return current

        const [signals, next] = changed

        yield* Effect.forEach(signals, send, { discard: true })

        return { ...next, changedAt: yield* Clock.currentTimeMillis }
      })
    )

  const withStatuses = (current: State, f: (statuses: Map<string, ChatSignal.StatusShown>) => void) => {
    const statuses = new Map(current.statuses)

    f(statuses)

    return { ...current, statuses }
  }

  // A tool's own status, or a message on its way, says more than the summary: it goes.
  const withoutSummary = (current: State): readonly [ReadonlyArray<ChatSignal.ChatSignal>, State] =>
    current.statuses.has(summaryKey)
      ? [
          [ChatSignal.StatusCleared.make({ key: summaryKey })],
          withStatuses(current, (statuses) => statuses.delete(summaryKey))
        ]
      : [[], current]

  const live: Live = {
    show: (key, text, source) =>
      change((current) => {
        const shown = ChatSignal.StatusShown.make({ key, text, source })
        const before = current.statuses.get(key)

        if (before !== undefined && before.text === text && before.source === source) return undefined

        const [cleared, rest] = source === "tool" ? withoutSummary(current) : [[], current]

        return [[...cleared, shown], withStatuses(rest, (statuses) => statuses.set(key, shown))]
      }),
    clear: (key) =>
      change((current) =>
        current.statuses.has(key)
          ? [[ChatSignal.StatusCleared.make({ key })], withStatuses(current, (statuses) => statuses.delete(key))]
          : undefined
      ),
    typing: (typing) =>
      change((current) => {
        if (current.typing === typing) return undefined

        if (!typing) return [[ChatSignal.TypingStopped.make({})], { ...current, typing }]

        const [cleared, rest] = withoutSummary(current)

        return [[...cleared, ChatSignal.TypingStarted.make({})], { ...rest, typing }]
      }),
    state: SynchronizedRef.get(state),
    reset: change((current) => {
      const signals: ReadonlyArray<ChatSignal.ChatSignal> = [
        ...(current.typing ? [ChatSignal.TypingStopped.make({})] : []),
        ...[...current.statuses.keys()].map((key) => ChatSignal.StatusCleared.make({ key }))
      ]

      return signals.length === 0 ? undefined : [signals, { ...current, statuses: new Map(), typing: false }]
    })
  }

  return live
})
