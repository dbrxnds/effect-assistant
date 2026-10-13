/**
 * Tool calls that wait for the user's approval.
 *
 * A tool made with Effect's `needsApproval` doesn't run when the model calls it in a turn: the
 * call waits ({@link AssistantEvent.ApprovalRequested}), the turn ends, and the chat's timeline
 * shows it to the user. Their decision, built with {@link approve} or {@link reject} and submitted
 * like a message, wakes a turn: an approved call runs then, with its params and id, and a rejected
 * one doesn't. A call the user moved on from expires ({@link expireStale}).
 *
 * @since 0.4.0
 */
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as AssistantEvent from "./AssistantEvent.ts"
import { CurrentChat } from "./CurrentChat.ts"
import * as InputId from "./InputId.ts"

/**
 * Represents where a call that waits for approval stands: `"pending"` until the user decides,
 * then `"approved"` or `"rejected"`, or `"expired"` when the user moved on.
 *
 * @category models
 * @since 0.4.0
 */
export type Status = "pending" | "approved" | "rejected" | "expired"

/**
 * Represents a tool call that waited, or waits, for the user's approval.
 *
 * @category models
 * @since 0.4.0
 */
export interface State {
  readonly request: AssistantEvent.ApprovalRequested
  /** When the call started waiting, in epoch milliseconds. */
  readonly at: number
  readonly status: Status
  /** The user's reason, when they rejected it with one. */
  readonly reason: string | undefined
  /** How the approved call went, once it ran. */
  readonly outcome: AssistantEvent.ToolOutcome | undefined
}

const decided = (state: State, decision: AssistantEvent.ApprovalDecision): State =>
  decision.reason === undefined
    ? { ...state, status: decision.decision }
    : { ...state, status: decision.decision, reason: decision.reason }

/**
 * Returns the approvals after one more entry. Fold a chat's entries in order, or use
 * {@link fromEntries}.
 *
 * **Details**
 *
 * The first of a call's decision and its expiry counts: anything after it changes nothing.
 *
 * @category combinators
 * @since 0.4.0
 */
export const apply = (
  states: ReadonlyMap<string, State>,
  entry: AssistantEvent.AnyEntry
): ReadonlyMap<string, State> => {
  const { event } = entry

  if (!AssistantEvent.isLibraryEvent(event)) return states

  if (Predicate.isTagged(event, "ApprovalRequested")) {
    return states.has(event.callId)
      ? states
      : new Map(states).set(event.callId, {
          request: event,
          at: entry.at,
          status: "pending",
          reason: undefined,
          outcome: undefined
        })
  }

  if (Predicate.isTagged(event, "ApprovalDecision")) {
    const state = states.get(event.callId)

    return state === undefined || state.status !== "pending"
      ? states
      : new Map(states).set(event.callId, decided(state, event))
  }

  if (Predicate.isTagged(event, "ApprovalsExpired")) {
    const expired = event.callIds.flatMap((callId) => {
      const state = states.get(callId)

      return state === undefined || state.status !== "pending" ? [] : [{ ...state, status: "expired" as const }]
    })

    if (expired.length === 0) return states

    const next = new Map(states)

    for (const state of expired) next.set(state.request.callId, state)

    return next
  }

  if (Predicate.isTagged(event, "ToolResult")) {
    const state = states.get(event.callId)

    return state === undefined || state.status !== "approved"
      ? states
      : new Map(states).set(event.callId, { ...state, outcome: event.outcome })
  }

  return states
}

/**
 * Returns every call that waited for approval in a chat, by call id, with where it stands.
 *
 * @category constructors
 * @since 0.4.0
 */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): ReadonlyMap<string, State> =>
  entries.reduce(apply, new Map<string, State>())

/**
 * The id of a decision on a call: the same for every decision on it, so the chat stores one.
 *
 * @category utils
 * @since 0.4.0
 */
export const decisionId = (callId: string): InputId.InputId => InputId.fromKey(`approval:${callId}`)

/**
 * Returns the input that approves a call waiting for the user's approval, to submit like a
 * message. `approval` is the call's item on the chat's timeline, or anything with the call's id.
 *
 * **Example** (Approve and reject buttons on the client)
 *
 * ```tsx
 * import { ToolApproval } from "effect-assistant"
 *
 * const buttons = (approval: { readonly id: string; readonly status: ToolApproval.Status }) =>
 *   approval.status === "pending" ? (
 *     <>
 *       <button onClick={() => submit(ToolApproval.approve(approval))}>Approve</button>
 *       <button onClick={() => submit(ToolApproval.reject(approval, { reason: "Not this week" }))}>Reject</button>
 *     </>
 *   ) : null
 * ```
 *
 * @category constructors
 * @since 0.4.0
 */
export const approve = (approval: { readonly id: string }): AssistantEvent.ApprovalDecision =>
  AssistantEvent.ApprovalDecision.make({ id: decisionId(approval.id), callId: approval.id, decision: "approved" })

/**
 * Returns the input that rejects a call waiting for the user's approval, with an optional short
 * reason the model reads.
 *
 * @see {@link approve} for an example
 *
 * @category constructors
 * @since 0.4.0
 */
export const reject = (
  approval: { readonly id: string },
  options?: { readonly reason?: string | undefined }
): AssistantEvent.ApprovalDecision =>
  options?.reason === undefined
    ? AssistantEvent.ApprovalDecision.make({ id: decisionId(approval.id), callId: approval.id, decision: "rejected" })
    : AssistantEvent.ApprovalDecision.make({
        id: decisionId(approval.id),
        callId: approval.id,
        decision: "rejected",
        reason: options.reason
      })

/**
 * Returns the ids of the calls still waiting for approval after the user typed the given number
 * of messages without deciding them.
 *
 * **Details**
 *
 * These are the calls {@link expireStale} expires.
 *
 * @category utils
 * @since 0.4.0
 */
export const staleApprovals = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  options: { readonly messages: number }
): ReadonlyArray<string> => {
  const states = fromEntries(entries)

  return [...states.values()].flatMap((state) => {
    if (state.status !== "pending") return []

    const requested = entries.findIndex(
      ({ event }) =>
        AssistantEvent.isLibraryEvent(event) &&
        Predicate.isTagged(event, "ApprovalRequested") &&
        event.callId === state.request.callId
    )

    const typed = entries.slice(requested + 1).filter(({ event }) => Predicate.isTagged(event, "UserMessage")).length

    return typed >= options.messages ? [state.request.callId] : []
  })
}

/**
 * Expires the calls the user moved on from, which still wait for approval after the given number
 * of typed messages.
 *
 * **Details**
 *
 * Run it from a turn, before or after its loop, like `BlockKit.closeStale`. It records an
 * `ApprovalsExpired` event: the timeline shows the calls as expired, the model reads that they
 * weren't approved, and a decision that arrives later isn't stored.
 *
 * @see {@link staleApprovals} for the calls it expires
 *
 * @category utils
 * @since 0.4.0
 */
export const expireStale = Effect.fn(function* (options: { readonly messages: number }) {
  const chat = yield* CurrentChat
  const stale = staleApprovals(yield* chat.entries, options)

  if (stale.length > 0) yield* chat.append(AssistantEvent.ApprovalsExpired.make({ callIds: stale }))
})
