/**
 * The `AssistantActivity` module says what is working in a chat right now,
 * read from its log: the assistant's turn, and specialist runs.
 *
 * Each is open from the event that starts it until the one that ends it: a
 * turn from `TurnStarted` to `TurnCompleted` or `TurnFailed`, a specialist
 * run from `SpecialistStarted` to `SpecialistFinished`. An input is open until a
 * turn that read it ends, so the gap before its turn starts counts too.
 * Anything merely waiting, like a workflow on an approval, isn't working: the
 * assistant took its last step, and the workflow wakes it with a fact.
 *
 * **Example** (A working indicator)
 *
 * ```ts
 * import { AssistantActivity } from "effect-assistant"
 *
 * const activity = AssistantActivity.fromEntries(entries)
 *
 * if (AssistantActivity.isWorking(activity)) {
 *   // Show who: the assistant, or `activity.specialists`.
 * }
 * ```
 *
 * @since 0.1.0
 */
import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import * as AssistantEvent from "./AssistantEvent.ts"
import type { RunId } from "./RunId.ts"

/**
 * A specialist run that is working.
 *
 * @category models
 * @since 0.1.0
 */
export interface SpecialistRun {
  readonly runId: RunId
  readonly specialist: string
  /** The goal it's working on, if the log recorded it. */
  readonly goal: string | undefined
  /** When it started, in epoch milliseconds. */
  readonly since: number
}

/**
 * What is working in a chat.
 *
 * @category models
 * @since 0.1.0
 */
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

/**
 * Nothing working: a chat with an empty log.
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
 * Returns the activity after one more entry. Fold a chat's entries in order,
 * or use {@link fromEntries}.
 *
 * @category combinators
 * @since 0.1.0
 */
export const apply = (activity: Activity, entry: AssistantEvent.Entry): Activity => {
  const event = entry.event

  if (AssistantEvent.isInput(event)) {
    // A finished run's report is an input, and ends the run.
    const current = Predicate.isTagged(event, "SpecialistFinished") ? withoutRun(activity, event.runId) : activity

    return AssistantEvent.wakes(event) ? { ...current, queued: true, lastInputSeq: entry.seq } : current
  }

  return Match.value(entry.event).pipe(
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

/**
 * Returns what is working after these entries.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.Entry>): Activity => entries.reduce(apply, empty)

/**
 * Returns whether anything is working: a turn (or one about to start), or a
 * specialist run.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isWorking = (activity: Activity): boolean =>
  activity.turnSince !== undefined || activity.queued || activity.specialists.size > 0
