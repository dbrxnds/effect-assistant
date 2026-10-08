/**
 * Lets the user approve or decline a tool call the assistant can't make on its own, such as
 * placing an order or publishing a post.
 *
 * When the model calls a tool marked with Effect's `needsApproval`, the call is parked instead of
 * run. The model asks the user with the decision {@link block}, and the user's answer to that
 * block runs the call or declines it. {@link fromEntries} computes where every decision in a
 * chat's log stands.
 *
 * @since 0.1.0
 */
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as AssistantEvent from "./AssistantEvent.ts"
import * as Block from "./Block.ts"
import * as DecisionId from "./DecisionId.ts"
import type { InputId } from "./InputId.ts"

/**
 * The kind of the decision block.
 *
 * @category utils
 * @since 0.1.0
 */
export const kind = "decision"

/**
 * Schema for the decision block's props, which list the decisions it asks for and, optionally,
 * its buttons' labels.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Props = Schema.Struct({
  // Plain strings: a strict tool schema with the id's pattern is too much for some providers; the
  // ids are checked against the decisions waiting when the message is sent.
  decisionIds: Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
    description:
      "The decisions to ask for: each waiting call's decisionId. Several go in one block when the user decides them together."
  }),
  approveLabel: Schema.optional(Schema.String).annotate({
    description: 'The approve button, like "Place order".'
  }),
  declineLabel: Schema.optional(Schema.String).annotate({
    description: 'The decline button, like "Cancel".'
  })
})

/**
 * Represents the decision block's props.
 *
 * @category models
 * @since 0.1.0
 */
export type Props = typeof Props.Type

/**
 * Schema for the decision block's answer, which holds an outcome for every decision the block
 * asks for, by id.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Answer = Schema.Struct({
  decisions: Schema.Record(Schema.String, AssistantEvent.DecisionOutcome)
})

/**
 * Represents the decision block's answer.
 *
 * @category models
 * @since 0.1.0
 */
export type Answer = typeof Answer.Type

/**
 * Block with approve and decline buttons for the decisions waiting for the user.
 *
 * **Details**
 *
 * Put it in the assistant's `BlockKit`. An assistant with a tool that needs a decision must have
 * it. The client renders it like any other block, with the calls from {@link fromEntries} (their
 * tool and params).
 *
 * **Example** (Asking the user before placing an order)
 *
 * ```ts
 * import { Assistant, BlockKit, Decision } from "effect-assistant"
 * import * as Tool from "effect/ai/Tool"
 * import * as Toolkit from "effect/ai/Toolkit"
 * import * as Effect from "effect/Effect"
 * import * as Layer from "effect/Layer"
 * import * as Schema from "effect/Schema"
 *
 * export const Shop = Assistant.make("shop", { blocks: BlockKit.make([Decision.block]) })
 *
 * const OrderTools = Toolkit.make(
 *   Tool.make("place_order", {
 *     description: "Places an order.",
 *     parameters: Schema.Struct({ sku: Schema.String, quantity: Schema.Int }),
 *     success: Schema.Struct({ reference: Schema.String }),
 *     needsApproval: true
 *   })
 * )
 *
 * const OrderToolsLive = OrderTools.toLayer({
 *   place_order: () => Effect.succeed({ reference: "R-1042" })
 * })
 *
 * // The call waits until the user answers the decision block.
 * const ShopLive = Shop.toLayer((turn) =>
 *   turn.loop({ instructions: "You place orders for the team.", toolkit: OrderTools })
 * ).pipe(Layer.provide(OrderToolsLive))
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const block = Block.make(kind, {
  description:
    "Approve / decline buttons for decisions waiting for the user: a call of yours that waits for their decision. The only way such a decision is made: write what they decide on (the call's key facts), and put the decision ids in decisionIds.",
  props: Props,
  answer: Answer
})

/**
 * Creates an answer that gives every decision the block asks for the same outcome.
 *
 * This is what an "Approve" or "Decline" button sends.
 *
 * @category constructors
 * @since 0.1.0
 */
export const answerAll = (props: Props, outcome: AssistantEvent.DecisionOutcome): Answer => ({
  decisions: Object.fromEntries(props.decisionIds.map((id) => [id, outcome]))
})

/**
 * Represents the state of a decision.
 *
 * @category models
 * @since 0.1.0
 */
export interface State {
  readonly request: AssistantEvent.DecisionRequested
  /** How the user decided, or `undefined` while the decision waits. */
  readonly outcome: AssistantEvent.DecisionOutcome | undefined
  /** The id of the answer that decided it. */
  readonly answer: InputId | undefined
  /** Whether its `DecisionResolved` is stored. A workflow's decision has been passed on by then. */
  readonly resolved: boolean
  /** The approved call's result, once the call has run. */
  readonly result: AssistantEvent.ToolResult | undefined
}

const decodeAnswer = Schema.decodeUnknownOption(Answer)

/**
 * Returns the decision states after one more event.
 *
 * @category utils
 * @since 0.1.0
 */
export const apply = (
  states: ReadonlyMap<string, State>,
  event: { readonly _tag: string }
): ReadonlyMap<string, State> => {
  if (!AssistantEvent.isLibraryEvent(event)) return states

  const update = (id: string, f: (state: State) => State) => {
    const state = states.get(id)

    return state === undefined ? states : new Map(states).set(id, f(state))
  }

  if (Predicate.isTagged(event, "DecisionRequested")) {
    return states.has(event.id)
      ? states
      : new Map(states).set(event.id, {
          request: event,
          outcome: undefined,
          answer: undefined,
          resolved: false,
          result: undefined
        })
  }

  if (Predicate.isTagged(event, "DecisionResolved")) {
    return update(event.id, (state) => ({
      ...state,
      outcome: event.outcome,
      answer: event.answer,
      resolved: true
    }))
  }

  // A stored decision answer was checked against its block when it was submitted: the first one
  // for a decision decides it.
  if (Predicate.isTagged(event, "BlockAnswer") && event.kind === kind) {
    return Option.match(decodeAnswer(event.value), {
      onNone: () => states,
      onSome: ({ decisions }) => {
        const next = new Map(states)

        for (const [id, outcome] of Object.entries(decisions)) {
          const state = states.get(id)

          if (state !== undefined && state.outcome === undefined) next.set(id, { ...state, outcome, answer: event.id })
        }

        return next
      }
    })
  }

  if (Predicate.isTagged(event, "ToolResult")) {
    const id = DecisionId.fromCallId(event.callId)
    const state = states.get(id)

    return state !== undefined && Predicate.isTagged(state.request.origin, "Call") && state.outcome === "approved"
      ? update(id, (current) => ({ ...current, result: event }))
      : states
  }

  return states
}

/**
 * Returns every decision in the log and where it stands, by id.
 *
 * @category utils
 * @since 0.1.0
 */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): ReadonlyMap<string, State> => {
  let all: ReadonlyMap<string, State> = new Map()

  for (const entry of entries) all = apply(all, entry.event)

  return all
}
