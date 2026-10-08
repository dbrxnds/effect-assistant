/**
 * The `AssistantActivity` module says what is working in a chat right now,
 * read from its log: the assistant's turn, and specialist runs.
 */
import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import * as AssistantEvent from "./AssistantEvent.ts"
import type { RunId } from "./RunId.ts"

/** A specialist run that is working. */
export interface SpecialistRun {
  readonly runId: RunId
  readonly specialist: string
  /** The goal it's working on. */
  readonly goal: string
  /** When it started, in epoch milliseconds. */
  readonly since: number
}

/** What is working in a chat. */
export interface Activity {
  /** When the running turn started, in epoch milliseconds; `undefined` when no turn runs. */
  readonly turnSince: number | undefined
  /** Whether an input arrived that no finished turn has read: a turn is about to start. */
  readonly queued: boolean
  /** The newest input's seq. */
  readonly lastInputSeq: number
  /** Specialist runs that are working, by run id. */
  readonly specialists: ReadonlyMap<RunId, SpecialistRun>
}

/** Nothing working: a chat with an empty log. */
export const empty: Activity = {
  turnSince: undefined,
  queued: false,
  lastInputSeq: 0,
  specialists: new Map()
}

const withoutRun = (activity: Activity, runId: RunId): Activity => {
  if (!activity.specialists.has(runId)) return activity

  const specialists = new Map(activity.specialists)
  specialists.delete(runId)

  return { ...activity, specialists }
}

/** Options for folding activity. */
export interface Options {
  /** The tags of the app's events that wake a turn (see `AppEvent`): inputs too. Default: none. */
  readonly wakes?: ReadonlySet<string> | undefined
}

/**
 * Returns the activity after one more entry. Fold a chat's entries in order,
 * or use {@link fromEntries}.
 */
export const apply = (activity: Activity, entry: AssistantEvent.AnyEntry, options?: Options): Activity => {
  const event = entry.event

  if (!AssistantEvent.isLibraryEvent(event)) {
    return options?.wakes?.has(event._tag) === true ? { ...activity, queued: true, lastInputSeq: entry.seq } : activity
  }

  if (AssistantEvent.isInput(event)) {
    // A finished run's report is an input, and ends the run.
    const current = Predicate.isTagged(event, "SpecialistFinished") ? withoutRun(activity, event.runId) : activity

    return AssistantEvent.isWaking(event) ? { ...current, queued: true, lastInputSeq: entry.seq } : current
  }

  return Match.value(event).pipe(
    Match.tag("TurnStarted", (): Activity => ({ ...activity, turnSince: entry.at })),
    // Turns run one at a time, so an end closes whichever turn is open, also one a restart cut off.
    Match.tag("TurnCompleted", "TurnFailed", (ended): Activity => ({
      ...activity,
      turnSince: undefined,
      queued: activity.lastInputSeq > ended.throughSeq
    })),
    Match.tag("SpecialistStarted", (started): Activity => ({
      ...activity,
      specialists: new Map(activity.specialists).set(started.runId, {
        runId: started.runId,
        specialist: started.specialist,
        goal: started.goal,
        since: entry.at
      })
    })),
    Match.orElse(() => activity)
  )
}

/** Returns what is working after these entries. */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, options?: Options): Activity =>
  entries.reduce((activity, entry) => apply(activity, entry, options), empty)

/**
 * Returns whether anything is working: a turn (or one about to start), or a
 * specialist run.
 */
export const isWorking = (activity: Activity): boolean =>
  activity.turnSince !== undefined || activity.queued || activity.specialists.size > 0
