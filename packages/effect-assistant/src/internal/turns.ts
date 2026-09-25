/**
 * An assistant's registration, and running one turn: the turn's API for the
 * handler, recording what its loop does, and how the turn ends.
 *
 * @since 0.1.0
 * @internal
 */
import * as HistoryCheck from "@effect-uai/core/HistoryCheck"
import * as Items from "@effect-uai/core/Items"
import type * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as Assistant from "../Assistant.ts"
import * as AssistantActivity from "../AssistantActivity.ts"
import type { AssistantChat } from "../AssistantChat.ts"
import * as AssistantEvent from "../AssistantEvent.ts"
import * as AssistantLoop from "../AssistantLoop.ts"
import type * as BlockKit from "../BlockKit.ts"
import type * as Instructions from "../Instructions.ts"
import * as Skill from "../Skill.ts"
import type * as Specialist from "../Specialist.ts"
import * as History from "./history.ts"
import { mapText } from "./instructions.ts"
import * as Specialists from "./specialists.ts"
import * as Telemetry from "./telemetry.ts"
import * as Tools from "./tools.ts"

/**
 * The colleague preamble every assistant's instructions follow.
 *
 * @internal
 */
export const preamble = `You are a colleague working with the user in a chat.
- The user only sees what you send with send_user_message. Anything else you write is private.
- Every step is a tool call. When you have nothing more to do, call wait (in the same step as your last send_user_message, if any).
- Messages and facts can arrive at any time, also while you are working. Always handle the newest message. Don't repeat something you already told the user.
- A <fact> is an update from a tool or workflow, and a <specialist> is the report of a specialist you started. The user did not see either. Decide whether they need to know: tell them about results, questions for them, and problems; keep routine progress to yourself and just call wait.
- For slow work, start it in the background if you can, tell the user in one line, and follow up when the result arrives.
- Keep messages short, like texting a coworker.`

/** Host-visible failure when a turn handled the user's input but never spoke. */
export const silentTurnMessage = "I finished without sending a reply."

/** Added to the instructions for one more short pass when a turn would end without replying. */
export const replyNudge =
  "You haven't replied to the user's latest message yet. Send them a message now with send_user_message: the answer, or what you started and when they'll hear back."

/**
 * What `Assistant.make` defines: the name, blocks, specialists, and events.
 *
 * @internal
 */
export interface Definition {
  readonly name: string
  readonly blocks: BlockKit.BlockKit | undefined
  readonly specialists: ReadonlyArray<Specialist.Any>
  /** The app's own events, by schema. */
  readonly events: ReadonlyArray<Assistant.EventSchema>
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
  readonly builtins: Toolkit.Toolkit
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

  // Fails on a tool name used twice.
  const builtins = yield* Toolkit.compose(
    Toolkit.make(Tools.sendUserMessage(definition.blocks), Tools.wait),
    Specialists.toolkit(definition.specialists)
  ).pipe(Effect.orDie)

  const registration: Registration = { definition, model, open: options.open, specialists, builtins }

  return registration
})

const ProviderError = Schema.Struct({ _tag: Schema.optional(Schema.String), raw: Schema.Unknown })

/** A short failure message; provider errors keep their response body. */
const failureMessage = (cause: Cause.Cause<unknown>): string =>
  Option.match(Schema.decodeUnknownOption(ProviderError)(Cause.squash(cause)), {
    onNone: () => Cause.pretty(cause),
    onSome: ({ _tag, raw }) => `${_tag ?? "Error"}: ${Predicate.isString(raw) ? raw : JSON.stringify(raw)}`
  })

/** The specialist runs working now, for the prompt: what's in flight, without reading back through the chat. */
const runningNow = (entries: ReadonlyArray<AssistantEvent.Entry>, now: number): string => {
  const runs = [...AssistantActivity.fromEntries(entries).specialists.values()]

  if (runs.length === 0) return ""

  const minutes = (since: number) => Math.max(0, Math.round((now - since) / 60_000))

  const lines = runs.map(
    (run) => `- ${run.specialist} (${run.runId}), started ${minutes(run.since)} min ago: ${run.goal}`
  )

  return `\n\nRunning now:\n${lines.join("\n")}`
}

const lastSeq = (entries: ReadonlyArray<AssistantEvent.Entry>, otherwise: number) => entries.at(-1)?.seq ?? otherwise

/** The app's own event stored as `Custom`, decoded with its schema; any other entry as it is. */
const decodeEntry = (definition: Definition, entry: AssistantEvent.Entry): Assistant.Entry<any> => {
  if (!Predicate.isTagged(entry.event, "Custom")) return entry

  const { value } = entry.event

  for (const schema of definition.events) {
    const decoded = Schema.decodeUnknownOption(Schema.toCodecJson(schema))(value)

    if (Option.isSome(decoded)) return { chatId: entry.chatId, seq: entry.seq, at: entry.at, event: decoded.value }
  }

  return entry
}

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

  const items = entries.flatMap(({ event }) =>
    Predicate.isTagged(event, "ModelOutput")
      ? event.items
      : Predicate.isTagged(event, "ToolResult")
        ? [Items.toolCallOutput(event.callId, event.output)]
        : []
  )

  const open = HistoryCheck.findUnansweredCalls(items)

  if (open.length === 0) return

  yield* chat.append(
    open.map((call) =>
      AssistantEvent.ToolResult.make({
        callId: call.call_id,
        tool: call.name,
        output: started.has(call.call_id) ? History.mayHaveRunOutput : History.notRunOutput
      })
    )
  )
})

/**
 * Ends a turn that ran to the end. It fails, visibly, when the user's latest
 * input got no reply; an input that arrived after the turn's last read gets
 * the next turn, which replies.
 */
const finishTurn = Effect.fn(function* (chat: AssistantChat["Service"], read: number) {
  const entries = yield* chat.entries

  const end =
    History.owesReply(entries, read) && !History.unreadAfter(entries, read)
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

  // Reading the chat, for the history or the entries, moves how far the turn read.
  const entries = Effect.tap(chat.entries, (all) => Ref.update(read, (seq) => lastSeq(all, seq)))

  const history = Effect.map(entries, History.fromEntries)

  const instructions = (given: string | Instructions.Resolved) =>
    mapText(given, (text) => `${preamble}\n\n${text}${running}`)

  // Only send_user_message, and the call is forced: the reply pass can only reply.
  const replyOnly = Toolkit.fromArray(Object.values(builtins).filter((tool) => tool.name === "send_user_message"))

  const replyIfOwed = (options: Assistant.ReplyOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const all = yield* chat.entries
        const through = yield* Ref.get(read)

        // Something arrived after the loop's last read: the next turn reads it with the full loop, and replies.
        if (History.unreadAfter(all, through) || !History.owesReply(all, through)) return Stream.empty

        return AssistantLoop.stream({
          model: options.model,
          instructions: mapText(options.instructions, (text) => `${preamble}\n\n${text}\n\n${replyNudge}`),
          toolkit: replyOnly,
          // Not `history`: what the reply pass reads, it can only reply to, so it doesn't move how far the turn read.
          history: Effect.map(chat.entries, History.fromEntries),
          maxSteps: 1,
          // Named, not just required: a model used to calling wait would otherwise call a tool that isn't there.
          toolChoice: { type: "function", name: "send_user_message" }
        })
      })
    )

  const append = (...events: ReadonlyArray<{ readonly _tag: string }>) =>
    Effect.forEach(events, (event) => {
      const schema = definition.events.find((candidate) => Schema.is(candidate)(event))

      return schema === undefined
        ? Effect.die(`${event._tag} isn't one of the ${definition.name} assistant's events.`)
        : Effect.map(Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(event), (value) =>
            AssistantEvent.Custom.make({ name: event._tag, value })
          )
    }).pipe(Effect.orDie, Effect.flatMap(chat.append), Effect.asVoid)

  return {
    chatId: chat.chatId,
    history,
    entries: Effect.map(entries, (all) => all.map((entry) => decodeEntry(definition, entry))),
    append,
    tools: builtins,
    instructions,
    replyIfOwed,
    loop: (options) => {
      const skills = options.skills ?? []

      const loop = Stream.unwrap(
        Effect.map(
          // Fails on a tool name used twice, like a tool named after a built-in.
          Effect.orDie(Toolkit.compose(builtins, Skill.toolkit(skills), options.toolkit ?? {})),
          (toolkit) =>
            AssistantLoop.stream({
              model: options.model,
              instructions: mapText(instructions(options.instructions), (text) => Skill.withCatalog(text, skills)),
              toolkit,
              history,
              maxSteps: options.maxSteps ?? 16,
              toolChoice: "required"
            })
        )
      )

      return Stream.concat(loop, replyIfOwed({ model: options.model, instructions: options.instructions }))
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

    yield* Telemetry.agentInput(History.unhandledInputs(before))

    const started = yield* chat.append([
      AssistantEvent.TurnStarted.make({ assistant: options.registration.definition.name })
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
            ? AssistantEvent.ModelOutput.make({ items: event.items, seenThroughSeq })
            : event
        ])
      )

    yield* options.handler(turn).pipe(
      Stream.runForEach(record),
      Effect.onExit((exit) => (Exit.hasInterrupts(exit) ? Effect.void : closeOpenCalls(chat, startSeq))),
      Effect.provideContext(options.services),
      Effect.matchCauseEffect({
        onSuccess: () => Effect.flatMap(Ref.get(read), (through) => finishTurn(chat, through)),
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
