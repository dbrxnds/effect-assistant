/**
 * Decisions in a chat: whether a loop may park a call, which answers the
 * chat takes, and what's left to run or pass on.
 *
 * @since 0.1.0
 * @internal
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Response from "effect/unstable/ai/Response"
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred"
import type * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as AssistantEvent from "../AssistantEvent.ts"
import * as BlockKit from "../BlockKit.ts"
import * as Decision from "../Decision.ts"
import type { InputId } from "../InputId.ts"

/**
 * What a turn gives its loop, and a specialist's run doesn't: parking calls
 * that need the user's decision, and the approved calls to run. A turn's
 * specialists inherit its context, so their runs set it back to none.
 *
 * @internal
 */
export const TurnDecisions = Context.Reference<
  Option.Option<{
    /** The approved calls that haven't run yet. */
    readonly approved: Effect.Effect<ReadonlyArray<AssistantEvent.ToolCallPart>>
  }>
>("effect-assistant/TurnDecisions", { defaultValue: Option.none })

/**
 * A decision an answer makes.
 *
 * @internal
 */
export interface Decided {
  readonly request: AssistantEvent.DecisionRequested
  readonly outcome: AssistantEvent.DecisionOutcome
}

/**
 * What the chat does with a submitted input: store it as is, refuse it, or
 * store it and resolve the decisions it answers.
 *
 * @internal
 */
export type Verdict = Data.TaggedEnum<{
  Store: {}
  Refuse: { readonly reason: string }
  Decide: { readonly decided: ReadonlyArray<Decided>; readonly answer: InputId }
}>

const Verdicts = Data.taggedEnum<Verdict>()

const store = Verdicts.Store()

const refuse = (reason: string) => Verdicts.Refuse({ reason })

const decodeProps = Schema.decodeUnknownOption(Decision.Props)

const decodeAnswer = Schema.decodeUnknownOption(Decision.Answer)

const messageOf = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, id: string) =>
  entries
    .map(({ event }) => event)
    .find(
      (event): event is AssistantEvent.AssistantMessage =>
        AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "AssistantMessage") && event.id === id
    )

/** A block answer's verdict: one on a decision block decides exactly what it asks, once. */
const answerVerdict = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, answer: AssistantEvent.BlockAnswer) => {
  const message = messageOf(entries, answer.messageId)
  const onDecisionBlock = message?.block?.kind === Decision.kind

  if (!onDecisionBlock && answer.kind !== Decision.kind) return store

  if (message?.block === undefined || !onDecisionBlock || answer.kind !== Decision.kind) {
    return refuse(`${answer.messageId} has no decision block.`)
  }

  if (BlockKit.blockStates(entries).get(message.id)?.open !== true)
    return refuse(`The block on ${message.id} is closed.`)

  const props = decodeProps(message.block.props)
  const value = decodeAnswer(answer.value)

  if (Option.isNone(props) || Option.isNone(value)) return refuse(`That isn't an answer to the block on ${message.id}.`)

  const asked = props.value.decisionIds
  const given = Object.keys(value.value.decisions)

  if (given.length !== asked.length || !given.every((id) => asked.some((askedId) => askedId === id))) {
    return refuse(`An answer decides exactly the decisions its block asks for: ${asked.join(", ")}.`)
  }

  const states = Decision.states(entries)
  const decided: Array<Decided> = []

  for (const id of asked) {
    const state = states.get(id)
    const outcome = value.value.decisions[id]

    if (state === undefined || outcome === undefined) return refuse(`No decision ${id}.`)

    if (state.outcome !== undefined) return refuse(`${id} is already decided.`)

    decided.push({ request: state.request, outcome })
  }

  return Verdicts.Decide({ decided, answer: answer.id })
}

/**
 * Returns what the chat does with a submitted input, given its entries. A
 * parked call comes only from the chat's own loop, so a submitted one is
 * refused.
 *
 * @internal
 */
export const verdict = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  input: AssistantEvent.Input | AssistantEvent.StoredAppEvent
): Verdict => {
  if (!AssistantEvent.isLibraryEvent(input)) return store

  if (Predicate.isTagged(input, "DecisionRequested")) {
    return Predicate.isTagged(input.origin, "Call")
      ? refuse("A tool call waits for a decision only from the chat's own loop.")
      : store
  }

  return Predicate.isTagged(input, "BlockAnswer") ? answerVerdict(entries, input) : store
}

/**
 * Returns the decisions answered but not resolved: a restart cut the chat
 * off between storing an answer and resolving what it decided.
 *
 * @internal
 */
export const unresolved = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>
): ReadonlyArray<Decided & { readonly answer: InputId }> =>
  [...Decision.states(entries).values()].flatMap((state) =>
    state.outcome !== undefined && state.answer !== undefined && !state.resolved
      ? [{ request: state.request, outcome: state.outcome, answer: state.answer }]
      : []
  )

/**
 * Returns the approved calls that haven't run: they run, with the ids and
 * params the model gave them, before the model's next step.
 *
 * @internal
 */
export const approvedCalls = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>
): ReadonlyArray<AssistantEvent.ToolCallPart> =>
  [...Decision.states(entries).values()].flatMap(({ request, outcome, resolved, result }) =>
    Predicate.isTagged(request.origin, "Call") && resolved && outcome === "approved" && result === undefined
      ? [
          Response.makePart("tool-call", {
            id: request.origin.callId,
            name: request.origin.tool,
            params: request.origin.params,
            providerExecuted: false
          })
        ]
      : []
  )

// The token names the deferred to complete; this one only encodes the outcome, like the one the workflow waits on.
const anyDecision = DurableDeferred.make("effect-assistant/Decision", { success: AssistantEvent.DecisionOutcome })

/**
 * Completes a workflow's decision: the deferred its token names.
 *
 * @internal
 */
export const complete = (
  token: string,
  outcome: AssistantEvent.DecisionOutcome
): Effect.Effect<void, never, WorkflowEngine.WorkflowEngine> =>
  DurableDeferred.succeed(anyDecision, { token: DurableDeferred.Token.make(token), value: outcome })
