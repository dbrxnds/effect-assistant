import type * as LanguageModel from "effect/ai/LanguageModel"
import * as Response from "effect/ai/Response"
import type * as Tool from "effect/ai/Tool"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as ErrorReporter from "effect/ErrorReporter"
import * as Exit from "effect/Exit"
import { identity } from "effect/Function"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as Assistant from "../Assistant.ts"
import type { ChatId } from "../ChatId.ts"
import * as AssistantEvent from "../AssistantEvent.ts"
import type * as AssistantLoop from "../AssistantLoop.ts"
import * as Loop from "./loop.ts"
import * as BlockKit from "../BlockKit.ts"
import type { CurrentChat } from "../CurrentChat.ts"
import * as Instructions from "../Instructions.ts"
import * as ToolApproval from "../ToolApproval.ts"
import type * as Specialist from "../Specialist.ts"
import * as AppEvents from "./events.ts"
import * as History from "./history.ts"
import { mapText } from "./instructions.ts"
import { toJsonText } from "./schema.ts"
import * as Specialists from "./specialists.ts"
import * as Telemetry from "./telemetry.ts"
import * as Toolkits from "./toolkit.ts"
import type { Writer } from "./writer.ts"
import * as Tools from "./tools.ts"

/** @internal */
export const silentTurnMessage = "I finished without sending a reply."

/** @internal */
export const defaultReplyNudge =
  "You haven't replied to the user's latest message yet. Reply now with send_user_message."

/** @internal */
export const deliveryNudge =
  "You told the user you're on it, but stopped without giving them the result. Send it now with send_user_message; if part of it is still running, say what and that you'll report back. If they already have everything, call wait."

/** @internal */
export interface Definition {
  readonly name: string
  readonly blocks: BlockKit.BlockKit | undefined
  readonly specialists: ReadonlyArray<Specialist.Any>
  readonly app: AppEvents.AppEvents
}

// Once its build ran the layer's services are provided, so its streams need only what a turn provides.
/** @internal */
export type TurnHandler = (
  turn: Assistant.Turn<any>
) => Stream.Stream<AssistantLoop.Event, unknown, Assistant.TurnServices | LanguageModel.LanguageModel>

// The chat `CurrentChat` gives, with its entries typed as the assistant's decode returns them: the assistant's typed
// chat is this one, so it needs no check of its own.
/** @internal */
export interface TypedChat {
  readonly chatId: ChatId
  readonly entries: Effect.Effect<AppEvents.DecodedEntries>
  readonly append: CurrentChat["Service"]["append"]
}

/** @internal */
export interface Registration {
  readonly definition: Definition
  readonly model: Context.Context<LanguageModel.LanguageModel>
  readonly open: (chat: TypedChat) => Effect.Effect<TurnHandler, never, Scope.Scope | CurrentChat>
  readonly specialists: ReadonlyArray<{
    readonly specialist: Specialist.Any
    readonly built: Specialist.Built
  }>
  readonly builtins: Toolkits.Tools<Assistant.TurnServices>
}

/** @internal */
export const register = Effect.fnUntraced(function* (
  definition: Definition,
  options: { readonly open: Registration["open"] }
) {
  const model = yield* Effect.context<LanguageModel.LanguageModel>()

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

// Provider errors keep their response body.
const failureMessage = (cause: Cause.Cause<unknown>): string =>
  Option.match(Schema.decodeUnknownOption(ProviderError)(Cause.squash(cause)), {
    onNone: () => Cause.pretty(cause),
    onSome: ({ _tag, raw }) => `${_tag ?? "Error"}: ${Predicate.isString(raw) ? raw : toJsonText(raw)}`
  })

// Approved, and not run yet: also one a crash cut off while it ran, which runs again with the same id.
const approvedCalls = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): ReadonlyArray<AssistantEvent.ToolCallPart> =>
  [...ToolApproval.fromEntries(entries).values()].flatMap(({ request, status, outcome }) =>
    status === "approved" && outcome === undefined
      ? [
          Response.makePart("tool-call", {
            id: request.callId,
            name: request.tool,
            params: request.params,
            providerExecuted: false
          })
        ]
      : []
  )

const lastSequence = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, otherwise: number) =>
  entries.at(-1)?.sequence ?? otherwise

// The handler's stream can end between a step's output and its tools, or while they run. An interrupted turn (a
// shutdown) leaves its calls open instead: the next turn runs them again.
const closeOpenCalls = Effect.fnUntraced(function* (chat: Writer, startSequence: number) {
  const entries = (yield* chat.entries).filter(({ sequence }) => sequence > startSequence)

  const started = new Set(
    entries.flatMap(({ event }) => (Predicate.isTagged(event, "ToolStarted") ? [event.callId] : []))
  )

  const open = History.unansweredCalls(History.fromEntries(entries))

  if (open.length === 0) return

  yield* chat.append(
    open.map((call) =>
      AssistantEvent.ToolResult.make({
        callId: call.id,
        tool: call.name,
        outcome: "failure",
        ...(started.has(call.id)
          ? { result: History.mayHaveRunOutput, reason: "MayHaveRun" }
          : { result: History.notRunOutput, reason: "NotRun" })
      })
    )
  )
})

// The inputs before the turn's `TurnStarted` (at `startSequence`) woke it; past that, what its model outputs record
// reading.
const handledThrough = (entries: ReadonlyArray<AssistantEvent.AnyEntry>, startSequence: number) =>
  entries.reduce(
    (through, { sequence, event }) =>
      sequence > startSequence &&
      AssistantEvent.isLibraryEvent(event) &&
      Predicate.isTagged(event, "ModelOutput") &&
      event.seenThroughSequence !== undefined
        ? Math.max(through, event.seenThroughSequence)
        : through,
    startSequence
  )

// A turn that ran the loop fails visibly when the user's latest input got no reply; an input that arrived after what
// its model read gets the next turn, which replies. A handler that ended without the loop decided that itself.
const finishTurn = Effect.fnUntraced(function* (chat: Writer, read: number, ranLoop: boolean) {
  const entries = yield* chat.entries

  const end =
    ranLoop && History.owesReply(entries, read) && !History.unreadAfter(entries, read)
      ? AssistantEvent.TurnFailed.make({ throughSequence: read, message: silentTurnMessage })
      : AssistantEvent.TurnCompleted.make({ throughSequence: read })

  yield* chat.append([end])
})

// Everything stored so far counts as read, so a failing input isn't retried forever.
const failTurn = Effect.fnUntraced(function* (chat: Writer, cause: Cause.Cause<unknown>) {
  yield* Effect.logError("assistant turn failed", cause)
  yield* ErrorReporter.report(cause)

  const last = lastSequence(yield* chat.entries, 0)

  yield* chat.append([AssistantEvent.TurnFailed.make({ throughSequence: last, message: failureMessage(cause) })])
})

const makeTurnApi = (
  registration: Registration,
  chat: Writer,
  startSequence: number,
  checkOpen: Effect.Effect<void>,
  ranLoop: Ref.Ref<boolean>
): Assistant.Turn<any> => {
  const { definition, builtins } = registration
  const { app } = definition
  const shownTools = BlockKit.toolNames(definition.blocks)

  const running = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    Stream.unwrap(Ref.set(ranLoop, true).pipe(Effect.as(stream)))

  // With how far into the chat it goes: the step records it on the model's output.
  // Read before every model call: a chat the app deleted meanwhile stops here.
  const history = Effect.fnUntraced(function* (view: Assistant.HistoryView<any> = identity) {
    yield* checkOpen

    const all = yield* chat.entries

    const read: AssistantLoop.ChatHistory = {
      messages: History.fromEntries(view(AppEvents.decodeEntries(app, all))),
      throughSequence: lastSequence(all, startSequence)
    }

    return read
  })

  const instructions = (given: string | Instructions.Resolved) =>
    mapText(given, (text) => `${Instructions.protocol}\n\n${text}`)

  // The loop's own prompt and tools, so the prompt stays cached, with the nudge at the end.
  const replyPass = <R>(options: {
    readonly instructions: Instructions.Resolved
    readonly toolkit: Toolkits.Tools<R>
    readonly view: Assistant.HistoryView<any>
    readonly nudge: string | undefined
  }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const all = yield* chat.entries
        const through = handledThrough(all, startSequence)

        // Something arrived after what the loop's model read: the next turn reads it with the full loop, and replies.
        if (History.unreadAfter(all, through)) return Stream.empty

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
                ...History.fromEntries(options.view(AppEvents.decodeEntries(app, entries))),
                History.userText(nudge)
              ],
              throughSequence: lastSequence(entries, startSequence)
            }
          }),
          // A second step, for a reply after a call it was refused.
          maxSteps: 2,
          // The pass runs because the model wrote text of its own instead of replying, which reaches nobody: it has to
          // call a tool now. Changing the choice costs a read of the history at full price, on these rare turns only.
          toolChoice: "required"
          // The loop ran the approved calls; a pass that can only reply runs none.
        }).pipe(Stream.provideService(Loop.TurnApprovals, Option.none()))
      })
    )

  const replyIfOwed = (options: Assistant.ReplyOptions) =>
    running(
      replyPass({
        instructions: instructions(options.instructions),
        toolkit: builtins,
        view: identity,
        nudge: options.nudge
      })
    )

  const prepare = <T extends Record<string, Tool.Any>>(options: Assistant.RunOptions<T, any>) => {
    const own = Toolkits.showing(Toolkits.fromToolkitOrEmpty(options.toolkit), shownTools)

    return {
      system: instructions(options.instructions),
      toolkit: Toolkits.merge(builtins, own),
      view: options.history ?? identity
    }
  }

  return {
    chatId: chat.chatId,
    history,
    instructions,
    replyIfOwed,
    run: (options) => {
      const { system, toolkit, view } = prepare(options)
      const twice = Toolkits.duplicateNames(toolkit)

      const loop =
        twice.length > 0
          ? Stream.die(`Tool names used twice, like one named after a built-in: ${twice.join(", ")}`)
          : Loop.run({
              instructions: system,
              toolkit,
              history: history(view),
              maxSteps: options.maxSteps ?? 16
            })

      return running(Stream.concat(loop, replyPass({ instructions: system, toolkit, view, nudge: options.replyNudge })))
    }
  }
}

// Every event the handler's loop emits is recorded before the loop is pulled again.
/** @internal */
export const run = Effect.fnUntraced(
  function* (options: {
    readonly registration: Registration
    readonly handler: TurnHandler
    readonly chat: Writer
    readonly services: Context.Context<Assistant.TurnServices | LanguageModel.LanguageModel>
    // A chat the app deleted is deleted here, and the turn stops.
    readonly checkOpen: Effect.Effect<void>
  }) {
    const { chat } = options
    const before = yield* chat.entries

    yield* Telemetry.agentInput(History.unhandledInputs(before))

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

    const startSequence = lastSequence(started, 0)
    const ranLoop = yield* Ref.make(false)
    const turn = makeTurnApi(options.registration, chat, startSequence, options.checkOpen, ranLoop)

    const record = (event: AssistantLoop.Event) => chat.append([event])

    yield* options.handler(turn).pipe(
      Stream.runForEach(record),
      Effect.onExit((exit) => (Exit.hasInterrupts(exit) ? Effect.void : closeOpenCalls(chat, startSequence))),
      // A loop the app writes gets the assistant's own tools too, with this turn's services.
      Effect.provideService(
        Loop.TurnTools,
        Option.some(Toolkits.provide(options.registration.builtins, options.services))
      ),
      // A turn's loop waits for the user's approval, and runs the calls they approved.
      Effect.provideService(Loop.TurnApprovals, Option.some({ approved: Effect.map(chat.entries, approvedCalls) })),
      Effect.provideContext(options.services),
      Effect.matchCauseEffect({
        onSuccess: Effect.fnUntraced(function* () {
          const all = yield* chat.entries

          yield* finishTurn(chat, handledThrough(all, startSequence), yield* Ref.get(ranLoop))
        }),
        onFailure: (cause) => failTurn(chat, cause)
      })
    )

    // The trace's output is what the user saw this turn, and a failure if any.
    const shown = (yield* chat.entries).flatMap(({ event, sequence }) =>
      sequence > startSequence &&
      (Predicate.isTagged(event, "AssistantMessage") || Predicate.isTagged(event, "TurnFailed"))
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
