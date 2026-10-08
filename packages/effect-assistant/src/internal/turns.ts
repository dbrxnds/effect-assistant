/**
 * An assistant's registration, and running one turn: the turn's API for the
 * handler, recording what its loop does, and how the turn ends.
 */
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Tool from "effect/ai/Tool"
import type * as Prompt from "effect/ai/Prompt"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { identity } from "effect/Function"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as Assistant from "../Assistant.ts"
import type { AssistantChat } from "../AssistantChat.ts"
import * as AssistantEvent from "../AssistantEvent.ts"
import type * as AssistantLoop from "../AssistantLoop.ts"
import * as Loop from "./loop.ts"
import type * as BlockKit from "../BlockKit.ts"
import * as Decision from "../Decision.ts"
import * as Instructions from "../Instructions.ts"
import * as Skill from "../Skill.ts"
import * as Skills from "./skills.ts"
import type * as Specialist from "../Specialist.ts"
import * as Decisions from "./decisions.ts"
import * as AppEvents from "./events.ts"
import * as History from "./history.ts"
import { mapText } from "./instructions.ts"
import { toJsonText } from "./schema.ts"
import * as Specialists from "./specialists.ts"
import * as Telemetry from "./telemetry.ts"
import * as Toolkits from "./toolkit.ts"
import type { Writer } from "./writer.ts"
import * as Tools from "./tools.ts"

/** Host-visible failure when a turn handled the user's input but never spoke. */
export const silentTurnMessage = "I finished without sending a reply."

/**
 * The last message of one more short pass when a turn would end without
 * replying, unless the handler gives its own.
 */
export const defaultReplyNudge =
  "You haven't replied to the user's latest message yet. Reply now with send_user_message."

/**
 * The last message of the reply pass when the turn told the user it was on
 * their request and stopped without the result.
 */
export const deliveryNudge =
  "You told the user you're on it, but stopped without giving them the result. Send it now with send_user_message; if part of it is still running, say what and that you'll report back. If they already have everything, call wait."

/** What `Assistant.make` defines: the name, blocks, specialists, and events. */
export interface Definition {
  readonly name: string
  readonly blocks: BlockKit.BlockKit | undefined
  readonly specialists: ReadonlyArray<Specialist.Any>
  /** The app's own events. */
  readonly app: AppEvents.AppEvents
}

/**
 * An assistant's handler once its build ran: the layer's services are
 * provided, so its streams need only what a turn provides.
 */
export type TurnHandler = (
  turn: Assistant.Turn<any>
) => Stream.Stream<AssistantLoop.Event, unknown, Assistant.TurnServices | LanguageModel.LanguageModel>

/** An assistant as `toLayer` registers it with the engine. */
export interface Registration {
  readonly definition: Definition
  /** The model API the assistant's layer was given, for its turns and its specialists' runs. */
  readonly model: Context.Context<LanguageModel.LanguageModel>
  /** Runs the handler's build for a chat, in the chat's scope. */
  readonly open: Effect.Effect<TurnHandler, never, Scope.Scope | AssistantChat>
  readonly specialists: ReadonlyArray<{
    readonly specialist: Specialist.Any
    readonly built: Specialist.Built
  }>
  /** The assistant's own tools: `send_user_message`, `wait`, and the specialist tools. */
  readonly builtins: Toolkits.Tools<Assistant.TurnServices>
}

/**
 * Collects what a registration needs from the layer: the model API, and each
 * specialist's handler.
 */
export const register = Effect.fnUntraced(function* (
  definition: Definition,
  options: { readonly open: Registration["open"] }
) {
  const model = yield* Effect.context<LanguageModel.LanguageModel>()

  const decisionBlock = definition.blocks?.byKind.get(Decision.kind)

  if (decisionBlock !== undefined && decisionBlock !== Decision.block) {
    return yield* Effect.die(`The ${Decision.kind} block kind is the library's: use Decision.block.`)
  }

  const specialists = yield* Effect.forEach(
    definition.specialists,
    Effect.fnUntraced(function* (specialist) {
      const built = yield* Effect.serviceOption(specialist.Handler)

      if (Option.isNone(built)) {
        return yield* Effect.die(
          `No handler for the ${specialist.name} specialist: provide ${specialist.name}.toLayer.`
        )
      }

      return { specialist, built: built.value }
    })
  )

  const builtins = Toolkits.merge(
    yield* Tools.makeMessaging(definition.blocks),
    yield* Specialists.toolkit(definition.specialists)
  )

  const registration: Registration = {
    definition,
    model,
    open: options.open,
    specialists,
    builtins
  }

  return registration
})

const ProviderError = Schema.Struct({ _tag: Schema.optional(Schema.String), raw: Schema.Unknown })

/** A short failure message; provider errors keep their response body. */
const failureMessage = (cause: Cause.Cause<unknown>): string =>
  Option.match(Schema.decodeUnknownOption(ProviderError)(Cause.squash(cause)), {
    onNone: () => Cause.pretty(cause),
    onSome: ({ _tag, raw }) => `${_tag ?? "Error"}: ${Predicate.isString(raw) ? raw : toJsonText(raw)}`
  })

const lastSeq = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, otherwise: number) => entries.at(-1)?.seq ?? otherwise

/**
 * A history view's result as a history: each run of entries as the model
 * reads them, and prompt messages as they are, in order.
 */
const toHistory = (
  viewed: ReadonlyArray<Assistant.Entry<any> | Prompt.Message>,
  app: AppEvents.AppEvents
): ReadonlyArray<Prompt.Message> => {
  const out: Array<Prompt.Message> = []
  let run: Array<AssistantEvent.AnyEntry> = []

  const flush = () => {
    out.push(...History.fromEntries(run, (event) => AppEvents.read(app, event)))
    run = []
  }

  for (const item of viewed) {
    if (isEntry(item)) run.push(item)
    else {
      flush()
      out.push(item)
    }
  }

  flush()

  return out
}

const isEntry = (item: Assistant.Entry<any> | Prompt.Message): item is Assistant.Entry<any> =>
  Predicate.hasProperty(item, "seq")

/**
 * Closes the calls this turn made that have no result: the handler's stream
 * ended between a step's output and its tools, or while they ran. An
 * interrupted turn (a shutdown) leaves them open: the next turn runs them
 * again.
 */
const closeOpenCalls = Effect.fnUntraced(function* (chat: Writer, startSeq: number) {
  const entries = (yield* chat.entries).filter(({ seq }) => seq > startSeq)

  const started = new Set(
    entries.flatMap(({ event }) => (Predicate.isTagged(event, "ToolStarted") ? [event.callId] : []))
  )

  // Approved calls this turn started that have no result are cut off like any other; one not started yet waits.
  const all = yield* chat.entries
  const approved = Decisions.approvedCalls(all).filter((call) => started.has(call.id))
  const open = [...History.unansweredCalls(History.fromEntries(entries, () => undefined)), ...approved]

  if (open.length === 0) return

  yield* chat.append(
    open.map((call) =>
      AssistantEvent.ToolResult.make({
        callId: call.id,
        tool: call.name,
        outcome: "failure",
        ...(started.has(call.id)
          ? { result: History.mayHaveRunOutput, kind: "may_have_run" }
          : { result: History.notRunOutput, kind: "not_run" })
      })
    )
  )
})

/**
 * How far this turn handled the chat: the inputs that woke it (before its
 * `TurnStarted`, at `startSeq`), and everything the model read in it, as its
 * outputs record.
 */
const handledThrough = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, startSeq: number) =>
  entries.reduce(
    (through, { seq, event }) =>
      seq > startSeq &&
      AssistantEvent.isLibraryEvent(event) &&
      Predicate.isTagged(event, "ModelOutput") &&
      event.seenThroughSeq !== undefined
        ? Math.max(through, event.seenThroughSeq)
        : through,
    startSeq
  )

/**
 * Ends a turn that ran to the end. It fails, visibly, when the user's latest
 * input got no reply; an input that arrived after what its model read gets
 * the next turn, which replies.
 */
const finishTurn = Effect.fnUntraced(function* (chat: Writer, read: number, wakes: ReadonlySet<string>) {
  const entries = yield* chat.entries

  const end =
    History.owesReply(entries, read) && !History.unreadAfter(entries, read, wakes)
      ? AssistantEvent.TurnFailed.make({ throughSeq: read, message: silentTurnMessage })
      : AssistantEvent.TurnCompleted.make({ throughSeq: read })

  yield* chat.append([end])
})

/**
 * Ends a turn whose handler failed. Everything stored so far counts as read, so a failing input isn't retried forever.
 */
const failTurn = Effect.fnUntraced(function* (chat: Writer, cause: Cause.Cause<unknown>) {
  yield* Effect.logError("assistant turn failed", cause)

  const last = lastSeq(yield* chat.entries, 0)

  yield* chat.append([AssistantEvent.TurnFailed.make({ throughSeq: last, message: failureMessage(cause) })])
})

/**
 * The turn as its handler sees it. `startSeq` is its `TurnStarted`: the inputs before it woke the turn.
 */
const makeTurnApi = (
  registration: Registration,
  chat: Writer,
  startSeq: number,
  checkOpen: Effect.Effect<void>
): Assistant.Turn<any> => {
  const { definition, builtins } = registration
  const { app } = definition

  // With how far into the chat it goes: the step records it on the model's output.
  // Read before every model call: a chat the app deleted meanwhile stops here.
  const history = Effect.fnUntraced(function* (view: Assistant.HistoryView<any> = identity) {
    yield* checkOpen

    const all = yield* chat.entries

    const read: AssistantLoop.ChatHistory = {
      messages: toHistory(view(AppEvents.decodeEntries(app, all)), app),
      throughSeq: lastSeq(all, startSeq)
    }

    return read
  })

  const instructions = (given: string | Instructions.Resolved) =>
    mapText(given, (text) => `${Instructions.protocol}\n\n${text}`)

  /**
   * One more pass when the turn would end without the reply it owes: the
   * loop's own prompt and tools, so the prompt stays cached, with the nudge
   * at the end. Only send_user_message runs; any other call is refused.
   */
  const replyPass = <R>(options: {
    readonly instructions: Instructions.Resolved
    readonly toolkit: Toolkits.Tools<R>
    readonly view: Assistant.HistoryView<any>
    readonly nudge: string | undefined
  }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const all = yield* chat.entries
        const through = handledThrough(all, startSeq)

        // Something arrived after what the loop's model read: the next turn reads it with the full loop, and replies.
        if (History.unreadAfter(all, through, app.wakes)) return Stream.empty

        const owed = History.owesReply(all, through)
        const undelivered = !owed && History.owesDelivery(all, through)

        if (!owed && !undelivered) return Stream.empty

        const nudge = undelivered ? deliveryNudge : (options.nudge ?? defaultReplyNudge)

        return Loop.run({
          instructions: options.instructions,
          // A reply that's owed can only be sent; a result it may have given may also be for nobody.
          toolkit: Toolkits.runOnly(
            options.toolkit,
            owed ? [Tools.sendUserMessageName] : [Tools.sendUserMessageName, Tools.waitToolName],
            "Not now: reply to the user with send_user_message."
          ),
          history: Effect.gen(function* () {
            yield* checkOpen

            const entries = yield* chat.entries

            return {
              messages: [
                ...toHistory(options.view(AppEvents.decodeEntries(app, entries)), app),
                History.userText(nudge)
              ],
              throughSeq: lastSeq(entries, startSeq)
            }
          }),
          // A second step, for a reply after a call it was refused.
          maxSteps: 2
        })
      })
    )

  const replyIfOwed = (options: Assistant.ReplyOptions) =>
    replyPass({
      instructions: instructions(options.instructions),
      toolkit: builtins,
      view: identity,
      nudge: options.nudge
    })

  // What the loop sends for these options: its system prompt, its tools, and which entries it reads.
  const prepare = <T extends Record<string, Tool.Any>, RS>(options: Assistant.LoopOptions<T, RS, any>) => {
    const skills = options.skills ?? []

    return {
      system: mapText(instructions(options.instructions), (text) => Skill.withCatalog(text, skills)),
      toolkit: Toolkits.merge(
        Toolkits.merge(builtins, Skills.toTools(skills)),
        Toolkits.fromToolkitOrEmpty(options.toolkit)
      ),
      view: options.history ?? identity
    }
  }

  return {
    chatId: chat.chatId,
    history,
    instructions,
    replyIfOwed,
    loop: (options) => {
      const { system, toolkit, view } = prepare(options)
      const twice = Toolkits.duplicateNames(toolkit)

      const deciding = toolkit.definitions.filter(
        (tool) => tool.needsApproval !== undefined && tool.needsApproval !== false
      )

      const loop =
        twice.length > 0
          ? Stream.die(`Tool names used twice, like one named after a built-in: ${twice.join(", ")}`)
          : deciding.length > 0 && definition.blocks?.byKind.get(Decision.kind) === undefined
            ? Stream.die(
                `${deciding.map((tool) => tool.name).join(", ")} can wait for the user's decision: add Decision.block to the assistant's blocks.`
              )
            : Loop.run({
                instructions: system,
                toolkit,
                history: history(view),
                maxSteps: options.maxSteps ?? 16
              })

      return Stream.concat(loop, replyPass({ instructions: system, toolkit, view, nudge: options.replyNudge }))
    }
  }
}

/**
 * Runs one turn of a chat: the handler's loop, every event it emits recorded
 * before the loop is pulled again, then how the turn ended.
 */
export const run = Effect.fnUntraced(
  function* (options: {
    readonly registration: Registration
    readonly handler: TurnHandler
    readonly chat: Writer
    /** What a turn provides to its handler's stream. */
    readonly services: Context.Context<Assistant.TurnServices | LanguageModel.LanguageModel>
    /** Whether the app still has the chat: one it deleted is deleted, and the turn stops. */
    readonly checkOpen: Effect.Effect<void>
  }) {
    const { chat } = options
    const before = yield* chat.entries

    yield* Telemetry.agentInput(History.unhandledInputs(before, options.registration.definition.app.wakes))

    const assistant = options.registration.definition.name
    const traceId = yield* Telemetry.currentTraceId

    const started = yield* chat.append([
      AssistantEvent.TurnStarted.make(
        Option.match(traceId, {
          onNone: () => ({ assistant }),
          onSome: (id) => ({ assistant, traceId: id })
        })
      )
    ])

    const startSeq = lastSeq(started, 0)
    const turn = makeTurnApi(options.registration, chat, startSeq, options.checkOpen)

    const record = (event: AssistantLoop.Event) => chat.append([event])

    yield* options.handler(turn).pipe(
      Stream.runForEach(record),
      Effect.onExit((exit) => (Exit.hasInterrupts(exit) ? Effect.void : closeOpenCalls(chat, startSeq))),
      // A loop the app writes gets the assistant's own tools too, with this turn's services.
      Effect.provideService(
        Loop.TurnTools,
        Option.some(Toolkits.provide(options.registration.builtins, options.services))
      ),
      Effect.provideContext(options.services),
      Effect.matchCauseEffect({
        onSuccess: Effect.fnUntraced(function* () {
          const all = yield* chat.entries

          yield* finishTurn(chat, handledThrough(all, startSeq), options.registration.definition.app.wakes)
        }),
        onFailure: (cause) => failTurn(chat, cause)
      })
    )

    // What the user saw this turn, and a failure if any, as the trace's output.
    const shown = (yield* chat.entries).flatMap(({ event, seq }) =>
      seq > startSeq && (Predicate.isTagged(event, "AssistantMessage") || Predicate.isTagged(event, "TurnFailed"))
        ? [event]
        : []
    )

    yield* Telemetry.agentOutput(shown)
  },
  (effect, options) =>
    effect.pipe(
      Telemetry.agentSpan(options.registration.definition.name, {
        chatId: options.chat.chatId,
        root: true
      })
    )
)
