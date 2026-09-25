/**
 * What both assistant layers share: a turn's setup (tools, prompt, loop), storing
 * inputs, and running turns until nothing is pending.
 *
 * @since 0.1.0
 * @internal
 */
import * as HistoryCheck from "@effect-uai/core/HistoryCheck"
import * as Items from "@effect-uai/core/Items"
import type * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberSet from "effect/FiberSet"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as PubSub from "effect/PubSub"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type * as Assistant from "../Assistant.ts"
import * as AssistantActivity from "../AssistantActivity.ts"
import { AssistantChat } from "../AssistantChat.ts"
import * as AssistantEvent from "../AssistantEvent.ts"
import * as AssistantLoop from "../AssistantLoop.ts"
import { AssistantTurn } from "../AssistantTurn.ts"
import type * as BlockKit from "../BlockKit.ts"
import type { ChatId } from "../ChatId.ts"
import { ChatLog } from "../ChatLog.ts"
import type * as Instructions from "../Instructions.ts"
import * as Skill from "../Skill.ts"
import type * as Specialist from "../Specialist.ts"
import * as SpecialistService from "../Specialist.ts"
import * as History from "./history.ts"
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

/** Host-visible failure when a turn handled client input but never spoke. */
export const silentTurnMessage = "I finished without sending a reply."

/** Added to the instructions for one more short pass when a turn would end without replying. */
export const replyNudge =
  "You haven't replied to the user's latest message yet. Send them a message now with send_user_message: the answer, or what you started and when they'll hear back."

const ProviderError = Schema.Struct({ _tag: Schema.optional(Schema.String), raw: Schema.Unknown })

/**
 * Whether the user's latest message (or block answer) read through `throughSeq`
 * has nothing after it for them: no reply, and no failure they were shown.
 */
const owesReply = (entries: ReadonlyArray<AssistantEvent.Entry>, throughSeq: number): boolean => {
  let latestInput = 0

  for (const { event, seq } of entries) {
    if (seq <= throughSeq && AssistantEvent.isInput(event) && AssistantEvent.isClientInput(event)) latestInput = seq
  }

  return latestInput > 0 &&
    !entries.some(({ event, seq }) =>
      seq > latestInput && (Predicate.isTagged(event, "AssistantMessage") || Predicate.isTagged(event, "TurnFailed"))
    )
}

/** Whether an input arrived after `throughSeq`: another turn will read it. */
const unreadAfter = (entries: ReadonlyArray<AssistantEvent.Entry>, throughSeq: number): boolean =>
  entries.some(({ event, seq }) => seq > throughSeq && AssistantEvent.isInput(event))

/** A short failure message; provider errors keep their response body. */
const failureMessage = (cause: Cause.Cause<unknown>): string =>
  Schema.decodeUnknownOption(ProviderError)(Cause.squash(cause)).pipe(
    Option.match({
      onNone: () => Cause.pretty(cause),
      onSome: ({ _tag, raw }) => `${_tag ?? "Error"}: ${Predicate.isString(raw) ? raw : JSON.stringify(raw)}`
    })
  )

/**
 * What `Assistant.make` defines: the name, blocks, and specialists.
 *
 * @internal
 */
export interface Definition {
  readonly name: string
  readonly blocks: BlockKit.BlockKit | undefined
  readonly specialists: ReadonlyArray<Specialist.Any>
  /** The app's own events, by schema. */
  readonly events: ReadonlyArray<Schema.Codec<{ readonly _tag: string }, any>>
}

/**
 * An assistant's handler build, with the services of the layer that
 * registered it. The build runs once per chat activation.
 *
 * @internal
 */
export interface Built {
  readonly build: Effect.Effect<Assistant.Handler<any, any, any>, unknown, any>
  readonly context: Context.Context<never>
}

/**
 * Runs a handler's build for a chat, in the current scope (the chat's): with
 * the layer's services and `AssistantChat`. A build that fails is a defect.
 *
 * @internal
 */
export const openHandler = <H>(
  built: { readonly build: Effect.Effect<H, unknown, any>; readonly context: Context.Context<never> },
  chatId: ChatId
): Effect.Effect<H, never, Scope.Scope> => // SAFETY: the build needs the layer's services, which `context` holds, AssistantChat, and a scope.
(built.build.pipe(
  Effect.provideService(AssistantChat, { chatId }),
  Effect.provide(built.context),
  Effect.orDie
) as Effect.Effect<H, never, Scope.Scope>)

/** The specialist runs working now, for the prompt: what's in flight, without reading back through the chat. */
const runningNow = (entries: ReadonlyArray<AssistantEvent.Entry>, now: number): string => {
  const runs = [...AssistantActivity.fromEntries(entries).specialists.values()]

  if (runs.length === 0) return ""

  const minutes = (since: number) => Math.max(0, Math.round((now - since) / 60_000))

  return `\n\nRunning now:\n${
    runs.map((run) =>
      `- ${run.specialist} (${run.runId}), started ${minutes(run.since)} min ago${
        run.goal === undefined ? "" : `: ${run.goal}`
      }`
    ).join("\n")
  }`
}

/** Instructions with their text changed. */
const mapText = (
  instructions: string | Instructions.Resolved,
  f: (text: string) => string
): Instructions.Resolved =>
  Predicate.isString(instructions) ? { text: f(instructions) } : { ...instructions, text: f(instructions.text) }

/**
 * Everything a turn needs besides the chat: the model and handler context,
 * the assistant's own tools, the handler, and the specialists' handlers.
 *
 * @internal
 */
export const makeSetup = Effect.fn(function*(definition: Definition, built: Built) {
  // The layers' requirements guarantee the model and the specialists' handlers are here.
  const current = yield* Effect.context<LanguageModel.LanguageModel>()
  const context = Context.merge(current, built.context)

  const specialists = yield* Effect.forEach(
    definition.specialists,
    (specialist) =>
      // SAFETY: only a lookup; the key's own type says what it finds.
      Option.match(Context.getOption(current as Context.Context<unknown>, specialist.Handler), {
        onNone: () =>
          Effect.die(`No handler for the ${specialist.name} specialist: provide ${specialist.name}.toLayer.`),
        onSome: (handler) => Effect.succeed({ specialist, built: handler })
      })
  )

  // The assistant's own tools, next to whatever toolkit a turn's loop gets.
  const builtins = yield* Toolkit.compose(
    Toolkit.make(Tools.sendUserMessage(definition.blocks), Tools.wait),
    Specialists.toolkit(definition.specialists)
  ).pipe(Effect.orDie)

  return { context, builtins, build: built.build, specialists }
})

/** @internal */
export type Setup = Effect.Success<ReturnType<typeof makeSetup>>

/**
 * An assistant as `toLayer` registers it with the engine: its definition,
 * and the setup its turns run with.
 *
 * @internal
 */
export interface Registration {
  readonly definition: Definition
  readonly setup: Setup
}

/**
 * Stores inputs and runs turns for one chat.
 *
 * @internal
 */
export const makeTurns = Effect.fn(function*(
  definition: Definition,
  setup: Setup,
  handler: Assistant.Handler<any, any, any>,
  services: Context.Context<Exclude<Assistant.TurnServices, AssistantTurn>>
) {
  const log = yield* ChatLog

  /** Appends the input unless an input with its id is already stored. */
  const store = Effect.fn(function*(chatId: ChatId, input: AssistantEvent.Input) {
    const stored = yield* log.read(chatId)

    if (!stored.some(({ event }) => AssistantEvent.isInput(event) && event.id === input.id)) {
      yield* log.append(chatId, [input])
    }
  })

  const turn = Effect.fn(
    function*(chatId: ChatId) {
      const waking = History.unhandledInputs(yield* log.read(chatId))
      yield* Telemetry.agentInput(waking)
      const started = yield* log.append(chatId, [AssistantEvent.TurnStarted.make({ assistant: definition.name })])
      const startSeq = started.at(-1)?.seq ?? 0
      const assistantTurn: AssistantTurn["Service"] = { chatId }

      // The inputs that woke the turn count as handled when it ends, even if the handler never reads the history.
      let throughSeq = startSeq

      const history = log.read(chatId).pipe(
        Effect.map((entries) => {
          throughSeq = entries.at(-1)?.seq ?? throughSeq

          return History.fromEntries(entries)
        })
      )

      const record = (event: AssistantLoop.Event) =>
        log.append(chatId, [
          Predicate.isTagged(event, "ModelOutput")
            ? AssistantEvent.ModelOutput.make({ items: event.items, seenThroughSeq: throughSeq })
            : event
        ]).pipe(Effect.asVoid)

      // Only send_user_message, and the call is forced: the reply pass can only reply.
      const replyOnly = Toolkit.fromArray(
        Object.values(setup.builtins).filter((tool) => tool.name === "send_user_message")
      )

      const running = runningNow(yield* log.read(chatId), Date.now())

      const instructions = (given: string | Instructions.Resolved) =>
        mapText(given, (text) => `${preamble}\n\n${text}${running}`)

      // The reply pass reads the history without moving `throughSeq`: what it reads, it can only reply to.
      const unmarkedHistory = log.read(chatId).pipe(Effect.map((entries) => History.fromEntries(entries)))

      const replyIfOwed = (options: Assistant.ReplyOptions) =>
        Stream.unwrap(Effect.gen(function*() {
          const entries = yield* log.read(chatId)

          // Something arrived after the loop's last read: the next turn reads it with the full loop, and replies.
          if (unreadAfter(entries, throughSeq) || !owesReply(entries, throughSeq)) return Stream.empty

          return AssistantLoop.stream({
            model: options.model,
            instructions: mapText(options.instructions, (text) => `${preamble}\n\n${text}\n\n${replyNudge}`),
            toolkit: replyOnly,
            history: unmarkedHistory,
            maxSteps: 1,
            // Named, not just required: a model used to calling wait would otherwise call a tool that isn't there.
            toolChoice: { type: "function", name: "send_user_message" }
          })
        }))

      const decode = (entry: AssistantEvent.Entry): Assistant.Entry<any> => {
        if (!Predicate.isTagged(entry.event, "Custom")) return entry

        const { value } = entry.event

        for (const schema of definition.events) {
          const decoded = Schema.decodeUnknownOption(schema)(value)

          if (Option.isSome(decoded)) {
            return { chatId: entry.chatId, seq: entry.seq, at: entry.at, event: decoded.value }
          }
        }

        return entry
      }

      const append = (...events: ReadonlyArray<{ readonly _tag: string }>) =>
        Effect.forEach(events, (event) => {
          const schema = definition.events.find((candidate) => Schema.is(candidate)(event))

          return schema === undefined
            ? Effect.die(`${event._tag} isn't one of the ${definition.name} assistant's events.`)
            : Schema.encodeUnknownEffect(schema)(event).pipe(
              Effect.orDie,
              Effect.map((value) => AssistantEvent.Custom.make({ name: event._tag, value }))
            )
        }).pipe(Effect.flatMap((custom) => log.append(chatId, custom)), Effect.asVoid)

      const turnApi: Assistant.Turn<any> = {
        chatId,
        history,
        // Reading the entries counts as reading the chat, as reading the history does: a history built from
        // them (a trimmed or compacted one) moves how far the turn read.
        entries: log.read(chatId).pipe(
          Effect.tap((entries) =>
            Effect.sync(() => {
              throughSeq = entries.at(-1)?.seq ?? throughSeq
            })
          ),
          Effect.map((entries) => entries.map(decode))
        ),
        append,
        tools: setup.builtins,
        instructions,
        replyIfOwed,
        loop: (options) => {
          const skills = options.skills ?? []

          const loop = Stream.unwrap(Effect.gen(function*() {
            // Fails on a tool name used twice, like a tool named after a built-in.
            const toolkit = yield* Toolkit.compose(setup.builtins, Skill.toolkit(skills), options.toolkit ?? {}).pipe(
              Effect.orDie
            )

            return AssistantLoop.stream({
              model: options.model,
              instructions: mapText(instructions(options.instructions), (text) => Skill.withCatalog(text, skills)),
              toolkit,
              history,
              maxSteps: options.maxSteps ?? 16,
              toolChoice: "required"
            })
          }))

          return loop.pipe(Stream.concat(replyIfOwed({ model: options.model, instructions: options.instructions })))
        }
      }

      // Calls this turn made that have no result: the handler's stream ended between a step's output and its
      // tools, or while they ran. An interrupted turn (a shutdown) leaves them open: the next turn runs them again.
      const closeOpenCalls = Effect.gen(function*() {
        const entries = (yield* log.read(chatId)).filter(({ seq }) => seq > startSeq)

        const started = new Set(
          entries.flatMap(({ event }) => Predicate.isTagged(event, "ToolStarted") ? [event.callId] : [])
        )

        const items = entries.flatMap(({ event }) =>
          Predicate.isTagged(event, "ModelOutput")
            ? event.items
            : Predicate.isTagged(event, "ToolResult")
            ? [Items.toolCallOutput(event.callId, event.output)]
            : []
        )

        const open = HistoryCheck.findUnansweredCalls(items)

        if (open.length > 0) {
          yield* log.append(
            chatId,
            open.map((call) =>
              AssistantEvent.ToolResult.make({
                callId: call.call_id,
                tool: call.name,
                output: started.has(call.call_id) ? History.mayHaveRunOutput : History.notRunOutput
              })
            )
          )
        }
      })

      // Records every event the handler's stream emits, before it's pulled again.
      const runHandler = () => {
        const result = handler(turnApi)

        const events: Stream.Stream<AssistantLoop.Event, unknown, unknown> = Effect.isEffect(result)
          ? Stream.unwrap(result)
          : result

        // SAFETY: the handler's requirements are the layer's context and the turn services.
        return (events.pipe(
          Stream.runForEach(record),
          Effect.onExit((exit) => Exit.hasInterrupts(exit) ? Effect.void : closeOpenCalls)
        ) as Effect.Effect<
          void,
          unknown,
          LanguageModel.LanguageModel | Assistant.TurnServices
        >).pipe(
          Effect.provideService(AssistantTurn, assistantTurn),
          Effect.provide(services),
          Effect.provide(setup.context)
        )
      }

      const finishTurn = Effect.fn(function*() {
        const read = throughSeq
        const entries = yield* log.read(chatId)

        // An input that arrived after the loop's last read gets the next turn, which replies: no failure to show.
        const end = owesReply(entries, read) && !unreadAfter(entries, read)
          ? AssistantEvent.TurnFailed.make({ throughSeq: read, message: silentTurnMessage })
          : AssistantEvent.TurnCompleted.make({ throughSeq: read })

        yield* log.append(chatId, [end])
      })

      yield* runHandler().pipe(
        Effect.matchCauseEffect({
          onSuccess: () => finishTurn(),
          onFailure: Effect.fn(function*(cause: Cause.Cause<unknown>) {
            yield* Effect.logError("assistant turn failed", cause)
            // Mark everything stored so far as handled, so a failing input is not retried forever.
            const last = (yield* log.read(chatId)).at(-1)?.seq ?? throughSeq
            yield* log.append(chatId, [
              AssistantEvent.TurnFailed.make({ throughSeq: last, message: failureMessage(cause) })
            ])
          })
        })
      )

      // What the user saw this turn, and a failure if any, as the trace's output.
      const shown = (yield* log.read(chatId)).flatMap(({ event, seq }) =>
        seq > startSeq && (Predicate.isTagged(event, "AssistantMessage") || Predicate.isTagged(event, "TurnFailed"))
          ? [event]
          : []
      )

      yield* Telemetry.agentOutput(shown)
    },
    (effect, chatId) => effect.pipe(Telemetry.agentSpan(definition.name, { chatId, root: true }))
  )

  /** Runs turns until no input is left unhandled. */
  const drain = Effect.fn(function*(chatId: ChatId) {
    while (History.needsTurn(yield* log.read(chatId))) yield* turn(chatId)
  })

  return { log, store, drain }
})

/**
 * One chat of an assistant: its turns, one at a time, and its specialist
 * runs, all in the current scope.
 *
 * **Details**
 *
 * `submit` stores an input and runs turns until nothing is pending;
 * `submitInBackground` returns once the input is stored. A run's answer is
 * stored and gets a turn in the background, like an input.
 *
 * `keepAlive` is on while anything works in the background: a run, or turns
 * no request waits on. Background work cut off by an interruption leaves it
 * on, so a cluster entity starts again (see `resume`).
 *
 * @internal
 */
export const makeChat = Effect.fn(function*(options: {
  readonly registration: Registration
  readonly chatId: ChatId
  readonly keepAlive: (enabled: boolean) => Effect.Effect<void>
}) {
  const { chatId, registration: { definition, setup } } = options
  const stored = yield* ChatLog
  const fibers = yield* FiberSet.make()
  const lock = Semaphore.makeUnsafe(1)
  const writes = Semaphore.makeUnsafe(1)
  const channel = yield* PubSub.unbounded<AssistantEvent.Entry>()
  let holds = 0

  yield* Effect.addFinalizer(() => PubSub.shutdown(channel))

  // The chat's log: its writers (the turn's loop, specialist runs, a handler's own appends) take one lock, so
  // each append is numbered after the last, and its entries go to the chat's subscribers.
  const log = ChatLog.of({
    read: stored.read,
    append: (id, events) =>
      id !== chatId
        ? stored.append(id, events)
        : stored.append(id, events).pipe(
          Effect.tap((entries) => PubSub.publishAll(channel, entries)),
          Semaphore.withPermit(writes)
        ),
    unfinished: stored.unfinished
  })

  // The handlers' builds run now, in the chat's scope: what they set up lives while the chat does.
  const handler = yield* openHandler({ build: setup.build, context: setup.context }, chatId)

  const specialists = yield* Effect.forEach(
    setup.specialists,
    ({ specialist, built }) =>
      Effect.map(openHandler(built, chatId), (opened) => ({
        specialist,
        built: { handler: opened, context: built.context }
      }))
  )

  const hold = (enabled: boolean) =>
    Effect.suspend(() => {
      holds += enabled ? 1 : -1

      return enabled && holds === 1 ? options.keepAlive(true) : !enabled && holds === 0
        ? options.keepAlive(false)
        : Effect.void
    })

  /** Works in the background, holding the keep-alive; an interruption keeps the hold. */
  const inBackground = (effect: Effect.Effect<void>) =>
    FiberSet.run(
      fibers,
      hold(true).pipe(
        Effect.andThen(effect),
        Effect.onExit((exit) => Exit.hasInterrupts(exit) ? Effect.void : hold(false))
      )
    ).pipe(Effect.asVoid)

  const drain = Effect.suspend(() => turns.drain(chatId)).pipe(Semaphore.withPermit(lock))

  const runner = yield* Specialists.makeRunner({
    specialists,
    // SAFETY: specialists run with the assistant's context plus the turn services.
    context: () => Context.merge(setup.context, services) as Context.Context<never>,
    answer: (_, fact) => turns.store(chatId, fact).pipe(Effect.andThen(inBackground(drain))),
    record: (_, event) => log.append(chatId, [event]).pipe(Effect.asVoid),
    keepAlive: hold
  })

  const services: Context.Context<Specialist.Runner | ChatLog> = Context.make(
    SpecialistService.Runner,
    runner
  ).pipe(Context.add(ChatLog, log))

  const turns = yield* makeTurns(definition, setup, handler, services).pipe(Effect.provideService(ChatLog, log))

  return {
    /** Stores the input, then runs turns until nothing is pending. */
    submit: (input: AssistantEvent.Input) => turns.store(chatId, input).pipe(Effect.andThen(drain)),
    /** Stores the input, and runs turns for it in the background. */
    submitInBackground: (input: AssistantEvent.Input) =>
      turns.store(chatId, input).pipe(Effect.andThen(inBackground(drain))),
    /** Runs turns in the background for inputs no turn has read, like an answer stored during a shutdown. */
    resume: Effect.gen(function*() {
      if (History.needsTurn(yield* log.read(chatId))) yield* inBackground(drain)
    }),
    /** The chat's stored entries, then new ones as they're appended. It subscribes before it reads. */
    stream: Stream.unwrap(Effect.gen(function*() {
      const subscription = yield* PubSub.subscribe(channel)
      const entries = yield* log.read(chatId)
      const after = entries.at(-1)?.seq ?? 0

      return Stream.concat(
        Stream.fromIterable(entries),
        Stream.fromSubscription(subscription).pipe(Stream.filter((entry) => entry.seq > after))
      )
    }))
  }
})

/** @internal */
export type Chat = Effect.Success<ReturnType<typeof makeChat>>
