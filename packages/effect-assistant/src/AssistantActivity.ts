/**
 * This module provides functions that determine what is working in a chat right now, read from
 * the chat's log.
 *
 * An {@link Activity} records whether the assistant is running a turn or is about to start one,
 * and which specialist runs are working. Fold a chat's entries into it with {@link apply}, or
 * build it from a list of entries with {@link fromEntries}, then check it with
 * {@link isWorking}.
 *
 * @since 0.1.0
 */
import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import * as AssistantEvent from "./AssistantEvent.ts"
import type { RunId } from "./RunId.ts"

/**
 * Represents a specialist run that is working.
 *
 * @category models
 * @since 0.1.0
 */
export interface SpecialistRun {
  readonly runId: RunId
  readonly specialist: string
  /** The goal the run is working on. */
  readonly goal: string
  /** When the run started, in epoch milliseconds. */
  readonly since: number
}

/**
 * Represents what is working in a chat.
 *
 * @category models
 * @since 0.1.0
 */
export interface Activity {
  /** When the running turn started, in epoch milliseconds, or `undefined` when no turn runs. */
  readonly turnSince: number | undefined
  /**
   * Whether an input arrived that no finished turn has read. When this is true, a turn is about
   * to start.
   */
  readonly queued: boolean
  /** The `seq` of the newest input. */
  readonly lastInputSeq: number
  /** Specialist runs that are working, by run id. */
  readonly specialists: ReadonlyMap<RunId, SpecialistRun>
}

/**
 * The activity of a chat with an empty log, where nothing is working.
 *
 * @category constructors
 * @since 0.1.0
 */
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

/**
 * Represents the options for folding a chat's entries into its activity.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The tags of the app's events that wake a turn (see `AppEvent`). These events count as inputs
   * too. Defaults to none.
   */
  readonly wakes?: ReadonlySet<string> | undefined
}

/**
 * Returns the activity after one more entry. Fold a chat's entries in order, or use
 * {@link fromEntries}.
 *
 * @category combinators
 * @since 0.1.0
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
    // Deleting a chat stops everything in it, and nothing starts again.
    Match.tag("ChatDeleted", (): Activity => ({ ...empty, lastInputSeq: activity.lastInputSeq })),
    Match.orElse(() => activity)
  )
}

/**
 * Returns what is working in a chat after the given entries, folded in order from
 * {@link empty}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, options?: Options): Activity =>
  entries.reduce((activity, entry) => apply(activity, entry, options), empty)

/**
 * Returns whether anything is working: a turn that is running or about to start, or a specialist
 * run.
 *
 * @category guards
 * @since 0.1.0
 */
export const isWorking = (activity: Activity): boolean =>
  activity.turnSince !== undefined || activity.queued || activity.specialists.size > 0
