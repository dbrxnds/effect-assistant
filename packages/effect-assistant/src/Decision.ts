/**
 * The `Decision` module is how the user approves or declines what the
 * assistant can't do on its own, like placing an order or publishing a post.
 * One primitive, asked for from two places, answered one way:
 */
import * as Effect from "effect/Effect"
import * as Filter from "effect/Filter"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Activity from "effect/workflow/Activity"
import * as DurableDeferred from "effect/workflow/DurableDeferred"
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine"
import type { AssistantEngine } from "./AssistantEngine.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import * as Block from "./Block.ts"
import type { ChatId } from "./ChatId.ts"
import * as DecisionId from "./DecisionId.ts"
import type { InputId } from "./InputId.ts"
import { toJson } from "./internal/schema.ts"

/** The decision block's kind. */
export const kind = "decision"

/**
 * Schema for the decision block's props: which decisions it asks for, and
 * optionally its buttons' labels.
 */
export const Props = Schema.Struct({
  // Plain strings: a strict tool schema with the id's pattern is too much for some providers; the ids are checked
  // against the decisions waiting when the message is sent.
  decisionIds: Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
    description:
      "The decisions to ask for: a waiting call's decisionId, or a <decision> request's id. Several go in one block when the user decides them together."
  }),
  approveLabel: Schema.optional(Schema.String).annotate({
    description: 'The approve button, like "Place order".'
  }),
  declineLabel: Schema.optional(Schema.String).annotate({
    description: 'The decline button, like "Cancel".'
  })
})

/** The decision block's props. */
export type Props = typeof Props.Type

/**
 * Schema for the decision block's answer: an outcome for every decision the
 * block asks for, by id.
 */
export const Answer = Schema.Struct({
  decisions: Schema.Record(Schema.String, AssistantEvent.DecisionOutcome)
})

/** The decision block's answer. */
export type Answer = typeof Answer.Type

/**
 * The decision block: approve / decline for decisions waiting for the user.
 * Put it in the assistant's `BlockKit`; an assistant with a tool that needs
 * a decision must have it. The client renders it like any block, with the
 * previews from {@link fromEntries}.
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
 */
export const answerAll = (props: Props, outcome: AssistantEvent.DecisionOutcome): Answer => ({
  decisions: Object.fromEntries(props.decisionIds.map((id) => [id, outcome]))
})

/** Where a decision stands. */
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

/** Returns the decision states after one more event. */
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
    const id = DecisionId.fromCallId(event.callId)
    const state = states.get(id)

    return state !== undefined && Predicate.isTagged(state.request.origin, "Call") && state.outcome === "approved"
      ? update(id, (current) => ({ ...current, result: event }))
      : states
  }

  return states
}

/** Returns every decision in the log and where it stands, by id. */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): ReadonlyMap<string, State> => {
  let all: ReadonlyMap<string, State> = new Map()

  for (const entry of entries) all = apply(all, entry.event)

  return all
}

/** What asking needs of an assistant: its `submit`. */
export interface Submitter {
  readonly submit: (chatId: ChatId, input: AssistantEvent.Input) => Effect.Effect<void, never, AssistantEngine>
}

/** Options for a decision that work asks for. */
export interface RequestOptions {
  /** Who asks, like `workflow:CreateCampaign`. */
  readonly source: string
  /** What the user decides on, like the order: any value with a JSON form. */
  readonly preview: unknown
}

/**
 * Asks the chat's user for a decision, from work that's already running:
 * stores a `DecisionRequested`, which wakes a turn, and returns its id. The
 * key makes asking again harmless: it gives the same id, and the request is
 * stored once.
 */
// Plain functions, not `Effect.fn`: a client that renders the block doesn't bundle the workflow modules.
export const request = (
  assistant: Submitter,
  chatId: ChatId,
  options: RequestOptions & { readonly key: string }
): Effect.Effect<DecisionId.DecisionId, never, AssistantEngine> =>
  Effect.gen(function* () {
    const id = DecisionId.fromKey(options.key)

    yield* assistant.submit(
      chatId,
      AssistantEvent.DecisionRequested.make({
        id,
        origin: AssistantEvent.WorkOrigin.make({ source: options.source }),
        preview: toJson(options.preview)
      })
    )

    return id
  })

/**
 * Waits until a decision is made, and returns how: reads the chat's log,
 * then follows it.
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
  Effect.gen(function* () {
    const found = yield* assistant
      .subscribe(chatId)
      .pipe(
        Stream.filterMap(
          Filter.fromPredicateOption(({ event }: { readonly event: { readonly _tag: string } }) =>
            AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "DecisionResolved") && event.id === id
              ? Option.some(event.outcome)
              : Option.none()
          )
        ),
        Stream.runHead
      )

    if (Option.isNone(found)) return yield* Effect.die(`The chat closed before ${id} was decided.`)

    return found.value
  })

/** The deferred a workflow's decision waits on: the answer completes it by its token. */
const deferred = (name: string) =>
  DurableDeferred.make(`effect-assistant/Decision/${name}`, {
    success: AssistantEvent.DecisionOutcome
  })

/**
 * Asks the chat's user for a decision from a workflow, and waits for it: the
 * workflow suspends until the user answers, across restarts, and resumes
 * with the outcome. `name` tells a workflow's decisions apart.
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
