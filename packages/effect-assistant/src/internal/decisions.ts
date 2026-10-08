import * as Response from "effect/ai/Response"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as AssistantEvent from "../AssistantEvent.ts"
import * as BlockKit from "../BlockKit.ts"
import * as Decision from "../Decision.ts"
import type { InputId } from "../InputId.ts"

// Only a turn's loop parks calls and runs approved ones. A turn's specialists inherit its context, so their runs set
// it back to none.
/** @internal */
export const TurnDecisions = Context.Reference<
  Option.Option<{
    readonly approved: Effect.Effect<ReadonlyArray<AssistantEvent.ToolCallPart>>
  }>
>("effect-assistant/TurnDecisions", { defaultValue: Option.none })

/** @internal */
export interface Decided {
  readonly request: AssistantEvent.DecisionRequested
  readonly outcome: AssistantEvent.DecisionOutcome
}

/** @internal */
export type Verdict = Data.TaggedEnum<{
  Store: Record<never, never>
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

const answerVerdict = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, answer: AssistantEvent.BlockAnswer) => {
  const message = messageOf(entries, answer.messageId)
  const onDecisionBlock = message?.block?.kind === Decision.kind

  if (!onDecisionBlock && answer.kind !== Decision.kind) return store

  if (message?.block === undefined || !onDecisionBlock || answer.kind !== Decision.kind) {
    return refuse(`${answer.messageId} has no decision block.`)
  }

  if (BlockKit.fromEntries(entries).get(message.id)?.open !== true)
    return refuse(`The block on ${message.id} is closed.`)

  const props = decodeProps(message.block.props)
  const value = decodeAnswer(answer.value)

  if (Option.isNone(props) || Option.isNone(value)) return refuse(`That isn't an answer to the block on ${message.id}.`)

  const asked = props.value.decisionIds
  const given = Object.keys(value.value.decisions)

  if (given.length !== asked.length || !given.every((id) => asked.some((askedId) => askedId === id))) {
    return refuse(`An answer decides exactly the decisions its block asks for: ${asked.join(", ")}.`)
  }

  const states = Decision.fromEntries(entries)
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

/** @internal */
export const verdict = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  input: AssistantEvent.Input | AssistantEvent.StoredAppEvent
): Verdict =>
  AssistantEvent.isLibraryEvent(input) && Predicate.isTagged(input, "BlockAnswer")
    ? answerVerdict(entries, input)
    : store

// A restart can cut the chat off between storing an answer and resolving what it decided.
/** @internal */
export const unresolved = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>
): ReadonlyArray<Decided & { readonly answer: InputId }> =>
  [...Decision.fromEntries(entries).values()].flatMap((state) =>
    state.outcome !== undefined && state.answer !== undefined && !state.resolved
      ? [{ request: state.request, outcome: state.outcome, answer: state.answer }]
      : []
  )

// They run with the ids and params the model gave them, before the model's next step.
/** @internal */
export const approvedCalls = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>
): ReadonlyArray<AssistantEvent.ToolCallPart> =>
  [...Decision.fromEntries(entries).values()].flatMap(({ request, outcome, resolved, result }) =>
    resolved && outcome === "approved" && result === undefined
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
