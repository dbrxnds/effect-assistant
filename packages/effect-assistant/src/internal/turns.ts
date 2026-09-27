/**
 * An assistant's registration, and running one turn: the turn's API for the
 * handler, recording what its loop does, and how the turn ends.
 *
 * @since 0.1.0
 * @internal
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { identity } from "effect/Function"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type * as Assistant from "../Assistant.ts"
import * as AssistantActivity from "../AssistantActivity.ts"
import type { AssistantChat } from "../AssistantChat.ts"
import * as AssistantEvent from "../AssistantEvent.ts"
import * as AssistantLoop from "../AssistantLoop.ts"
import type * as BlockKit from "../BlockKit.ts"
import * as Instructions from "../Instructions.ts"
import * as Skill from "../Skill.ts"
import type * as Specialist from "../Specialist.ts"
import * as AppEvents from "./events.ts"
import * as History from "./history.ts"
import { mapText } from "./instructions.ts"
import { toJsonText } from "./schema.ts"
import * as Specialists from "./specialists.ts"
import * as Telemetry from "./telemetry.ts"
import * as Toolkits from "./toolkit.ts"
import * as Tools from "./tools.ts"

/** Host-visible failure when a turn handled the user's input but never spoke. */
export const silentTurnMessage = "I finished without sending a reply."

/**
 * Added to the instructions for one more short pass when a turn would end
 * without replying, unless the handler gives its own.
 *
 * @internal
 */
export const defaultReplyNudge =
  "You haven't replied to the user's latest message yet. Reply now with send_user_message."

/**
 * What `Assistant.make` defines: the name, blocks, specialists, and events.
 *
 * @internal
 */
export interface Definition {
  readonly name: string
  readonly blocks: BlockKit.BlockKit | undefined
  readonly specialists: ReadonlyArray<Specialist.Any>
  /** The app's own events and inputs. */
  readonly app: AppEvents.AppEvents
}

/**
 * An assistant's handler once its build ran: the layer's services are
 * provided, so its streams need only what a turn provides.
 *
 * @internal
 */
export type TurnHandler = (
  turn: Assistant.Turn<any>
) => Stream.Stream<AssistantLoop.Event, unknown, Assistant.TurnServices | LanguageModel.LanguageModel>

/**
 * An assistant as `toLayer` registers it with the engine.
 *
 * @internal
 */
export interface Registration {
  readonly definition: Definition
  /** The model API the assistant's layer was given, for its turns and its specialists' runs. */
  readonly model: Context.Context<LanguageModel.LanguageModel>
  /** Runs the handler's build for a chat, in the chat's scope. */
  readonly open: Effect.Effect<TurnHandler, never, Scope.Scope | AssistantChat>
  readonly specialists: ReadonlyArray<{ readonly specialist: Specialist.Any; readonly built: Specialist.Built }>
  /** The assistant's own tools: `send_user_message`, `wait`, and the specialist tools. */
  readonly builtins: AssistantLoop.Tools<Assistant.TurnServices>
}

/**
 * Collects what a registration needs from the layer: the model API, and each
 * specialist's handler.
 *
 * @internal
 */
export const makeRegistration = Effect.fn(function* (
  definition: Definition,
  options: { readonly open: Registration["open"] }
) {
  const model = yield* Effect.context<LanguageModel.LanguageModel>()

  const specialists = yield* Effect.forEach(definition.specialists, (specialist) =>
    Effect.flatMap(Effect.serviceOption(specialist.Handler), (built) =>
      Option.isSome(built)
        ? Effect.succeed({ specialist, built: built.value })
        : Effect.die(`No handler for the ${specialist.name} specialist: provide ${specialist.name}.toLayer.`)
    )
  )

  const builtins = Toolkits.merge(
    yield* Tools.messaging(definition.blocks),
    yield* Specialists.toolkit(definition.specialists)
  )

  const registration: Registration = { definition, model, open: options.open, specialists, builtins }

  return registration
})

const ProviderError = Schema.Struct({ _tag: Schema.optional(Schema.String), raw: Schema.Unknown })

/** A short failure message; provider errors keep their response body. */
const failureMessage = (cause: Cause.Cause<unknown>): string =>
  Option.match(Schema.decodeUnknownOption(ProviderError)(Cause.squash(cause)), {
    onNone: () => Cause.pretty(cause),
    onSome: ({ _tag, raw }) => `${_tag ?? "Error"}: ${Predicate.isString(raw) ? raw : toJsonText(raw)}`
  })

/** The specialist runs working now, for the prompt: what's in flight, without reading back through the chat. */
const runningNow = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, now: number): string => {
  const runs = [...AssistantActivity.fromEntries(entries).specialists.values()]

  if (runs.length === 0) return ""

  const minutes = (since: number) => Math.max(0, Math.round((now - since) / 60_000))

  const lines = runs.map(
    (run) => `- ${run.specialist} (${run.runId}), started ${minutes(run.since)} min ago: ${run.goal}`
  )

  return `\n\nRunning now:\n${lines.join("\n")}`
}

const lastSeq = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, otherwise: number) => entries.at(-1)?.seq ?? otherwise

/**
 * A history view's result as a history: each run of entries as the model
 * reads them, and prompt messages as they are, in order.
 */
const toHistory = (
  viewed: ReadonlyArray<Assistant.Entry<any> | Prompt.Message>,
  inputs: ReadonlySet<string>
): ReadonlyArray<Prompt.Message> => {
  const out: Array<Prompt.Message> = []
  let run: Array<AssistantEvent.AnyEntry> = []

  const flush = () => {
    out.push(...History.fromEntries(run, inputs))
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
const closeOpenCalls = Effect.fn(function* (chat: AssistantChat["Service"], startSeq: number) {
  const entries = (yield* chat.entries).filter(({ seq }) => seq > startSeq)

  const started = new Set(
    entries.flatMap(({ event }) => (Predicate.isTagged(event, "ToolStarted") ? [event.callId] : []))
  )

  const open = History.unansweredCalls(History.fromEntries(entries, new Set()))

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
 * Ends a turn that ran to the end. It fails, visibly, when the user's latest
 * input got no reply; an input that arrived after the turn's last read gets
 * the next turn, which replies.
 */
const finishTurn = Effect.fn(function* (chat: AssistantChat["Service"], read: number, inputs: ReadonlySet<string>) {
  const entries = yield* chat.entries

  const end =
    History.owesReply(entries, read) && !History.unreadAfter(entries, read, inputs)
      ? AssistantEvent.TurnFailed.make({ throughSeq: read, message: silentTurnMessage })
      : AssistantEvent.TurnCompleted.make({ throughSeq: read })

  yield* chat.append([end])
})

/** Ends a turn whose handler failed. Everything stored so far counts as read, so a failing input isn't retried forever. */
const failTurn = Effect.fn(function* (chat: AssistantChat["Service"], cause: Cause.Cause<unknown>) {
  yield* Effect.logError("assistant turn failed", cause)

  const last = lastSeq(yield* chat.entries, 0)

  yield* chat.append([AssistantEvent.TurnFailed.make({ throughSeq: last, message: failureMessage(cause) })])
})

/** The turn as its handler sees it. `read` is how far the turn has read the chat. */
const makeTurnApi = (
  registration: Registration,
  chat: AssistantChat["Service"],
  read: Ref.Ref<number>,
  running: string
): Assistant.Turn<any> => {
  const { definition, builtins } = registration
  const { app } = definition

  const decoded = (all: ReadonlyArray<AssistantEvent.AnyEntry>) =>
    all.flatMap((entry) => Option.toArray(AppEvents.decodeEntry(app, entry)))

  // Reading the chat, for the history or the entries, moves how far the turn read.
  const entries = Effect.map(
    Effect.tap(chat.entries, (all) => Ref.update(read, (seq) => lastSeq(all, seq))),
    decoded
  )

  const history = (view: Assistant.HistoryView<any> = identity) =>
    Effect.map(entries, (all) => toHistory(view(all), app.inputs))

  const instructions = (given: string | Instructions.Resolved) =>
    mapText(given, (text) => `${Instructions.protocol}\n\n${text}${running}`)

  // Only send_user_message, and the call is forced: the reply pass can only reply.
  const replyOnly = Toolkits.only(builtins, [Tools.sendUserMessageName])

  const replyIfOwed = (options: Assistant.ReplyOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const all = yield* chat.entries
        const through = yield* Ref.get(read)

        // Something arrived after the loop's last read: the next turn reads it with the full loop, and replies.
        if (History.unreadAfter(all, through, app.inputs) || !History.owesReply(all, through)) return Stream.empty

        return AssistantLoop.stream({
          instructions: mapText(
            instructions(options.instructions),
            (text) => `${text}\n\n${options.nudge ?? defaultReplyNudge}`
          ),
          toolkit: replyOnly,
          // Not `history`: what the reply pass reads, it can only reply to, so it doesn't move how far the turn read.
          history: Effect.map(chat.entries, (all) => History.fromEntries(all, app.inputs)),
          maxSteps: 1,
          // Named, not just required: a model used to calling wait would otherwise call a tool that isn't there.
          toolChoice: { tool: Tools.sendUserMessageName }
        })
      })
    )

  const append = (...events: ReadonlyArray<{ readonly _tag: string }>) =>
    Effect.forEach(events, (event) => AppEvents.encode(app, event)).pipe(Effect.flatMap(chat.append), Effect.asVoid)

  return {
    chatId: chat.chatId,
    history,
    entries,
    append,
    tools: builtins,
    instructions,
    replyIfOwed,
    loop: (options) => {
      const skills = options.skills ?? []
      const toolkit = Toolkits.merge(Toolkits.merge(builtins, Skill.toolkit(skills)), options.toolkit ?? Toolkits.empty)
      const twice = Toolkits.duplicateNames(toolkit)

      const loop =
        twice.length > 0
          ? Stream.die(`Tool names used twice, like one named after a built-in: ${twice.join(", ")}`)
          : AssistantLoop.stream({
              instructions: mapText(instructions(options.instructions), (text) => Skill.withCatalog(text, skills)),
              toolkit,
              history: history(options.history),
              maxSteps: options.maxSteps ?? 16,
              toolChoice: "required"
            })

      return Stream.concat(loop, replyIfOwed({ instructions: options.instructions, nudge: options.replyNudge }))
    }
  }
}

/**
 * Runs one turn of a chat: the handler's loop, every event it emits recorded
 * before the loop is pulled again, then how the turn ended.
 *
 * @internal
 */
export const runTurn = Effect.fn(
  function* (options: {
    readonly registration: Registration
    readonly handler: TurnHandler
    readonly chat: AssistantChat["Service"]
    /** What a turn provides to its handler's stream. */
    readonly services: Context.Context<Assistant.TurnServices | LanguageModel.LanguageModel>
  }) {
    const { chat } = options
    const before = yield* chat.entries

    yield* Telemetry.agentInput(History.unhandledInputs(before, options.registration.definition.app.inputs))

    const assistant = options.registration.definition.name
    const traceId = yield* Telemetry.currentTraceId

    const started = yield* chat.append([
      AssistantEvent.TurnStarted.make(
        Option.match(traceId, { onNone: () => ({ assistant }), onSome: (id) => ({ assistant, traceId: id }) })
      )
    ])

    const startSeq = lastSeq(started, 0)
    // The inputs that woke the turn count as handled when it ends, even if the handler never reads the chat.
    const read = yield* Ref.make(startSeq)
    const running = runningNow(before, yield* Clock.currentTimeMillis)
    const turn = makeTurnApi(options.registration, chat, read, running)

    const record = (event: AssistantLoop.Event) =>
      Effect.flatMap(Ref.get(read), (seenThroughSeq) =>
        chat.append([
          Predicate.isTagged(event, "ModelOutput")
            ? AssistantEvent.ModelOutput.make({
                parts: event.parts,
                seenThroughSeq,
                model: event.model,
                responseId: event.responseId,
                usage: event.usage,
                durationMillis: event.durationMillis
              })
            : event
        ])
      )

    yield* options.handler(turn).pipe(
      Stream.runForEach(record),
      Effect.onExit((exit) => (Exit.hasInterrupts(exit) ? Effect.void : closeOpenCalls(chat, startSeq))),
      Effect.provideContext(options.services),
      Effect.matchCauseEffect({
        onSuccess: () =>
          Effect.flatMap(Ref.get(read), (through) =>
            finishTurn(chat, through, options.registration.definition.app.inputs)
          ),
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
    effect.pipe(Telemetry.agentSpan(options.registration.definition.name, { chatId: options.chat.chatId, root: true }))
)
