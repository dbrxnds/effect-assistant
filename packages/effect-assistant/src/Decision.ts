/**
 * The `Decision` module is how the user approves or declines what the
 * assistant can't do on its own, like placing an order or publishing a post.
 * One primitive, asked for from two places, answered one way:
 *
 * - **Before a call.** A tool whose native `needsApproval` says so (`true`,
 *   or a function of its params) doesn't run when the model calls it. The
 *   loop parks the call: it runs the tool's preview, if it has one (see
 *   `AssistantLoop.tools`), and records a `DecisionRequested`. The model
 *   reads, as the call's result, that it waits for the user's decision, with
 *   the decision's id and the preview. If the user approves, the turn runs
 *   exactly that call, with the same call id; if they decline, the model is
 *   told it didn't run.
 * - **During work.** Something already running, like a workflow, asks with
 *   {@link durable} (it waits for the answer) or {@link request}. That
 *   `DecisionRequested` is an input: it wakes a turn, and the model reads it.
 *   The answer completes the workflow's deferred.
 *
 * The library never asks the user itself. The model writes the message and
 * puts a decision {@link block} on it, for one decision or several. Using it
 * sends a `BlockAnswer`, and the chat records a `DecisionResolved` for each
 * decision it answers. An answer is refused (not stored) when its block is
 * closed, when it doesn't answer exactly the decisions its block asks for,
 * or when one of them is already decided; answers are taken one at a time,
 * so a decision is decided once.
 *
 * Only what the user must approve needs a decision. A plain choice, like
 * which office, stays an ordinary block.
 *
 * **Specialists** can't park a call: a specialist has no user to ask, so a
 * call of theirs to a tool that needs a decision fails, and they report back
 * what needs deciding. Their tools can still {@link request} a decision for
 * the chat; the assistant's turn then asks.
 *
 * **Example** (A tool that needs the user's decision, with a preview)
 *
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import * as Tool from "effect/unstable/ai/Tool"
 * import * as Toolkit from "effect/unstable/ai/Toolkit"
 * import { AssistantLoop, AssistantToolCall, BlockKit, Decision, ToolFailure } from "effect-assistant"
 *
 * const PlaceOrder = Tool.make("place_order", {
 *   description: "Places an order.",
 *   parameters: Schema.Struct({ sku: Schema.String, quantity: Schema.Int }),
 *   success: Schema.Struct({ reference: Schema.String }),
 *   failure: ToolFailure.ToolFailure,
 *   dependencies: [AssistantToolCall.AssistantToolCall],
 *   needsApproval: true
 * })
 *
 * const OrderTools = Toolkit.make(PlaceOrder)
 *
 * const MyAssistantLive = MyAssistant.toLayer(Effect.gen(function*() {
 *   const orders = yield* Orders
 *   const toolkit = AssistantLoop.tools(yield* OrderTools, {
 *     // What the user sees before they approve; a failure goes to the model instead.
 *     previews: { place_order: ({ sku, quantity }) => orders.quote(sku, quantity) }
 *   })
 *
 *   return (turn) => turn.loop({ instructions: "You help a small team.", toolkit })
 * }))
 *
 * // The decision block is one of the assistant's blocks.
 * export const Blocks = BlockKit.make([ChooseOne, Decision.block])
 * ```
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Filter from "effect/Filter"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Activity from "effect/unstable/workflow/Activity"
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred"
import type * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import type { AssistantEngine } from "./AssistantEngine.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import * as Block from "./Block.ts"
import type { ChatId } from "./ChatId.ts"
import * as DecisionId from "./DecisionId.ts"
import type { InputId } from "./InputId.ts"
import { toJson } from "./internal/schema.ts"

/**
 * The decision block's kind.
 *
 * @category constants
 * @since 0.1.0
 */
export const kind = "decision"

/**
 * Schema for the decision block's props: which decisions it asks for, and
 * optionally its buttons' labels.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Props = Schema.Struct({
  // Plain strings: a strict tool schema with the id's pattern is too much for some providers; the ids are checked
  // against the decisions waiting when the message is sent.
  decisionIds: Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
    description:
      "The decisions to ask for: a waiting call's decisionId, or a <decision> request's id. Several go in one block when the user decides them together."
  }),
  approveLabel: Schema.optional(Schema.String).annotate({ description: 'The approve button, like "Place order".' }),
  declineLabel: Schema.optional(Schema.String).annotate({ description: 'The decline button, like "Cancel".' })
})

/**
 * The decision block's props.
 *
 * @category models
 * @since 0.1.0
 */
export type Props = typeof Props.Type

/**
 * Schema for the decision block's answer: an outcome for every decision the
 * block asks for, by id.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Answer = Schema.Struct({
  decisions: Schema.Record(Schema.String, AssistantEvent.DecisionOutcome)
})

/**
 * The decision block's answer.
 *
 * @category models
 * @since 0.1.0
 */
export type Answer = typeof Answer.Type

/**
 * The decision block: approve / decline for decisions waiting for the user.
 * Put it in the assistant's `BlockKit`; an assistant with a tool that needs
 * a decision must have it. The client renders it like any block, with the
 * previews from {@link states}.
 *
 * @category blocks
 * @since 0.1.0
 */
export const block = Block.make(kind, {
  description:
    "Approve / decline buttons for decisions waiting for the user: a call of yours that waits for their decision, or a <decision> request. The only way such a decision is made: write what they decide on (the preview's key facts), and put the decision ids in decisionIds.",
  props: Props,
  answer: Answer
})

/**
 * The answer that gives every decision the block asks for the same outcome:
 * what an "Approve" or "Decline" button sends.
 *
 * @category constructors
 * @since 0.1.0
 */
export const answerAll = (props: Props, outcome: AssistantEvent.DecisionOutcome): Answer => ({
  decisions: Object.fromEntries(props.decisionIds.map((id) => [id, outcome]))
})

/**
 * Where a decision stands.
 *
 * @category models
 * @since 0.1.0
 */
export interface State {
  readonly request: AssistantEvent.DecisionRequested
  /** How the user decided; `undefined` while it waits. */
  readonly outcome: AssistantEvent.DecisionOutcome | undefined
  /** The answer that decided it. */
  readonly answer: InputId | undefined
  /** Whether its `DecisionResolved` is stored: a workflow's decision is passed on by then. */
  readonly resolved: boolean
  /** An approved call's result, once it ran. */
  readonly result: AssistantEvent.ToolResult | undefined
}

const decodeAnswer = Schema.decodeUnknownOption(Answer)

/**
 * Returns the decision states after one more event.
 *
 * **When to use**
 *
 * Use when a client folds the event stream one entry at a time.
 *
 * @see {@link states} for the states of a whole log
 *
 * @category folding
 * @since 0.1.0
 */
export const nextStates = (
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

  // A stored decision answer was checked against its block when it was submitted: the first one for a decision decides it.
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
    const id = DecisionId.forCall(event.callId)
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
 * @category folding
 * @since 0.1.0
 */
export const states = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): ReadonlyMap<string, State> => {
  let all: ReadonlyMap<string, State> = new Map()

  for (const entry of entries) all = nextStates(all, entry.event)

  return all
}

/**
 * What asking needs of an assistant: its `submit`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Submitter {
  readonly submit: (chatId: ChatId, input: AssistantEvent.Input) => Effect.Effect<void, never, AssistantEngine>
}

/**
 * Options for a decision that work asks for.
 *
 * @category models
 * @since 0.1.0
 */
export interface RequestOptions {
  /** Who asks, like `workflow:CreateCampaign`, as for a fact. */
  readonly source: string
  /** What the user decides on, like the order: any value with a JSON form. */
  readonly preview: unknown
}

/**
 * Asks the chat's user for a decision, from work that's already running:
 * stores a `DecisionRequested`, which wakes a turn, and returns its id. The
 * key makes asking again harmless: it gives the same id, and the request is
 * stored once.
 *
 * **When to use**
 *
 * Use from app code that isn't a workflow. The outcome is in the chat's log
 * ({@link states}, or wait for it with {@link outcome}). In a workflow, use
 * {@link durable}, which waits durably.
 *
 * @category constructors
 * @since 0.1.0
 */
// Plain functions, not `Effect.fn`: a client that renders the block doesn't bundle the workflow modules.
export const request = (
  assistant: Submitter,
  chatId: ChatId,
  options: RequestOptions & { readonly key: string }
): Effect.Effect<DecisionId.DecisionId, never, AssistantEngine> => {
  const id = DecisionId.fromKey(options.key)

  return assistant
    .submit(
      chatId,
      AssistantEvent.DecisionRequested.make({
        id,
        origin: AssistantEvent.WorkOrigin.make({ source: options.source }),
        preview: toJson(options.preview)
      })
    )
    .pipe(Effect.as(id))
}

/**
 * Waits until a decision is made, and returns how: reads the chat's log,
 * then follows it.
 *
 * @category getters
 * @since 0.1.0
 */
export const outcome = (
  assistant: {
    readonly subscribe: (
      chatId: ChatId
    ) => Stream.Stream<{ readonly event: { readonly _tag: string } }, never, AssistantEngine>
  },
  chatId: ChatId,
  id: DecisionId.DecisionId
): Effect.Effect<AssistantEvent.DecisionOutcome, never, AssistantEngine> =>
  assistant.subscribe(chatId).pipe(
    Stream.filterMap(
      Filter.fromPredicateOption(({ event }: { readonly event: { readonly _tag: string } }) =>
        AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "DecisionResolved") && event.id === id
          ? Option.some(event.outcome)
          : Option.none()
      )
    ),
    Stream.runHead,
    Effect.flatMap((found) =>
      Option.match(found, {
        onNone: () => Effect.die(`The chat closed before ${id} was decided.`),
        onSome: Effect.succeed
      })
    )
  )

/** The deferred a workflow's decision waits on: the answer completes it by its token. */
const deferred = (name: string) =>
  DurableDeferred.make(`effect-assistant/Decision/${name}`, { success: AssistantEvent.DecisionOutcome })

/**
 * Asks the chat's user for a decision from a workflow, and waits for it: the
 * workflow suspends until the user answers, across restarts, and resumes
 * with the outcome. `name` tells a workflow's decisions apart.
 *
 * **Details**
 *
 * The request is stored once, in an activity, with the deferred's token.
 * When the user answers, the chat completes the deferred, so the assistant's
 * layer needs the `WorkflowEngine` (the one the workflow runs on).
 *
 * **Example** (A workflow that waits for the user's approval)
 *
 * ```ts
 * const CreateCampaignLive = CreateCampaign.toLayer(Effect.fn(function*(payload) {
 *   const outcome = yield* Decision.durable(MyAssistant, {
 *     chatId: payload.chatId,
 *     name: "approval",
 *     source: "workflow:CreateCampaign",
 *     preview: { campaign: payload.name, budget: payload.budget }
 *   })
 *
 *   if (outcome === "declined") return yield* CampaignFailed.make({ reason: "declined" })
 *   // ...
 * }))
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const durable = (
  assistant: Submitter,
  options: RequestOptions & { readonly chatId: ChatId; readonly name: string }
): Effect.Effect<
  AssistantEvent.DecisionOutcome,
  never,
  AssistantEngine | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const waitingOn = deferred(options.name)
    const token = yield* DurableDeferred.token(waitingOn)

    yield* Activity.make({
      name: `effect-assistant/Decision/${options.name}`,
      execute: assistant.submit(
        options.chatId,
        AssistantEvent.DecisionRequested.make({
          id: DecisionId.fromKey(token),
          origin: AssistantEvent.WorkOrigin.make({ source: options.source, token }),
          preview: toJson(options.preview)
        })
      )
    })

    return yield* DurableDeferred.await(waitingOn)
  })
