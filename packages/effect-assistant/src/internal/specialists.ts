/**
 * Running specialists: a brief's loop, the specialist tools, and the chat's
 * runner.
 *
 * @since 0.1.0
 * @internal
 */
import * as Items from "@effect-uai/core/Items"
import type * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberMap from "effect/FiberMap"
import * as FiberSet from "effect/FiberSet"
import * as Predicate from "effect/Predicate"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { AssistantChat } from "../AssistantChat.ts"
import * as AssistantEvent from "../AssistantEvent.ts"
import * as AssistantLoop from "../AssistantLoop.ts"
import * as InputId from "../InputId.ts"
import * as RunId from "../RunId.ts"
import * as Skill from "../Skill.ts"
import * as Specialist from "../Specialist.ts"
import { mapText } from "./instructions.ts"
import * as Telemetry from "./telemetry.ts"

/**
 * A specialist's handler once its build ran for the chat.
 *
 * @internal
 */
export type RunHandler = (run: Specialist.Run) => Stream.Stream<AssistantLoop.Event, unknown, Specialist.RunServices>

/**
 * The brief as the specialist's message.
 *
 * @internal
 */
export const briefText = (brief: Specialist.Brief): string =>
  [
    `Goal: ${brief.goal}`,
    brief.context && `Context: ${brief.context}`,
    brief.successCriteria && `Done when: ${brief.successCriteria}`,
    brief.report && `Report back: ${brief.report}`,
    brief.limits && `Limits: ${brief.limits}`
  ]
    .filter(Boolean)
    .join("\n")

/** The last text the model wrote. */
const finalText = (items: ReadonlyArray<Items.HistoryItem>): string =>
  items
    .flatMap((item) => (Items.isMessage(item) && item.role === "assistant" ? item.content : []))
    .flatMap((content) => (Items.isOutputText(content) ? [content.text] : []))
    .join("")
    .trim()

/**
 * Runs a specialist's handler on its history until its loop ends, and
 * returns the answer: the last text the model wrote.
 *
 * **Details**
 *
 * What the loop does is added to `history`, so a follow-up continues it.
 * Messages offered to `inbox` while it runs join the history at its next
 * step. Each event the handler's stream emits is recorded before the stream
 * is pulled again, so the next step reads it.
 *
 * @internal
 */
export const runBrief = Effect.fn(
  function* (
    handler: RunHandler,
    options: {
      readonly specialist: Specialist.Any
      readonly runId: RunId.RunId
      readonly brief: Specialist.Brief
      readonly history: Ref.Ref<ReadonlyArray<Items.HistoryItem>>
      readonly inbox: Queue.Queue<Items.HistoryItem>
      readonly chatId: AssistantChat["Service"]["chatId"]
    }
  ) {
    const { history, inbox } = options
    const answer = yield* Ref.make("")
    const add = (items: ReadonlyArray<Items.HistoryItem>) => Ref.update(history, (all) => [...all, ...items])

    // Read before every model call, when no tool calls are open: messages sent meanwhile join it now.
    const current = Effect.gen(function* () {
      yield* add(yield* Queue.clear(inbox))

      return yield* Ref.get(history)
    })

    const run: Specialist.Run = {
      runId: options.runId,
      chatId: options.chatId,
      brief: options.brief,
      history: current,
      loop: (loop) => {
        const skills = loop.skills ?? []

        return AssistantLoop.stream({
          model: loop.model,
          instructions: mapText(loop.instructions, (text) => Skill.withCatalog(text, skills)),
          toolkit: { ...Skill.toolkit(skills), ...loop.toolkit },
          history: current,
          maxSteps: loop.maxSteps ?? 8
        })
      }
    }

    // A run lives in memory, so there's nothing to run again after a crash: `ToolStarted` isn't kept.
    const record = (event: AssistantLoop.Event) =>
      Predicate.isTagged(event, "ToolStarted")
        ? Effect.void
        : Predicate.isTagged(event, "ToolResult")
          ? add([Items.toolCallOutput(event.callId, event.output)])
          : Effect.gen(function* () {
              yield* add(event.items)
              const text = finalText(event.items)

              if (text.length > 0) yield* Ref.set(answer, text)
            })

    yield* Stream.runForEach(handler(run), record)

    const text = yield* Ref.get(answer)

    yield* Telemetry.agentOutput(text)

    return text
  },
  (effect, _handler, options) => effect.pipe(Telemetry.agentSpan(options.specialist.name, { chatId: options.chatId }))
)

/** How a brief went. */
type Outcome =
  | { readonly status: "answered"; readonly report: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "stopped" | "cut_off" }

/**
 * What a run reports when it finishes a brief. Its id is fixed per run and
 * brief, so a replay is stored once.
 *
 * @internal
 */
export const finished = (
  specialist: string,
  run: { readonly runId: RunId.RunId; readonly brief: number; readonly goal: string },
  outcome: Outcome
): AssistantEvent.SpecialistFinished =>
  AssistantEvent.SpecialistFinished.make({
    id: InputId.fromKey(`${run.runId}:${run.brief}`),
    runId: run.runId,
    specialist,
    brief: run.brief,
    goal: run.goal,
    ...outcome
  })

/**
 * Returns `spawn_specialist`, `message_specialist`, and `stop_specialist` for
 * these specialists, or an empty toolkit when there are none.
 *
 * @internal
 */
export const toolkit = (specialists: ReadonlyArray<Specialist.Any>): Toolkit.Toolkit => {
  if (specialists.length === 0) return {}

  const catalog = specialists.map((specialist) => `- ${specialist.name}: ${specialist.description}`).join("\n")
  const RunIdInput = Schema.String.annotate({ description: "The runId spawn_specialist returned." })

  const fail = <A>(effect: Effect.Effect<A, Specialist.SpecialistError, Specialist.Runner>) =>
    Effect.catch(effect, (error) => Tool.fail(error.message))

  const SpawnInput = Schema.Struct({
    kind: Schema.Literals(specialists.map((specialist) => specialist.name)),
    ...Specialist.Brief.fields
  })

  const spawn = Tool.make({
    name: "spawn_specialist",
    description: `Start a specialist on a job. It works in the background and its report arrives as a <specialist> input, often within seconds. Write a self-contained brief: it can't see this chat. For a quick question, just call wait; for slow work, tell the user in one line first.\n${catalog}`,
    inputSchema: SpawnInput,
    run: Effect.fn(function* ({ kind, ...brief }: typeof SpawnInput.Type) {
      const runId = yield* fail(Specialist.Runner.use((runner) => runner.spawn({ kind, brief })))

      return { runId, status: "started" }
    })
  })

  const MessageInput = Schema.Struct({ runId: RunIdInput, message: Schema.String })

  const message = Tool.make({
    name: "message_specialist",
    description:
      "Send more to one of your specialists: new instructions for a running one (it reads them at its next step), or a follow-up for a finished one (it continues with what it already found).",
    inputSchema: MessageInput,
    run: Effect.fn(function* ({ runId, message }: typeof MessageInput.Type) {
      const status = yield* fail(Specialist.Runner.use((runner) => runner.message(runId, message)))

      return { runId, status }
    })
  })

  const StopInput = Schema.Struct({ runId: RunIdInput })

  const stop = Tool.make({
    name: "stop_specialist",
    description:
      "Stop one of your running specialists, for example when the user changed their mind. It posts no answer.",
    inputSchema: StopInput,
    run: Effect.fn(function* ({ runId }: typeof StopInput.Type) {
      yield* fail(Specialist.Runner.use((runner) => runner.stop(runId)))

      return { runId, status: "stopped" }
    })
  })

  return Toolkit.make(spawn, message, stop)
}

/** How long a finished run stays available for follow-ups. */
const warm = "15 minutes"

/** A run of the chat: one specialist's history, continued by follow-ups. */
interface Run {
  readonly runId: RunId.RunId
  readonly specialist: Specialist.Any
  readonly handler: RunHandler
  readonly goal: string
  readonly brief: Specialist.Brief
  readonly history: Ref.Ref<ReadonlyArray<Items.HistoryItem>>
  /** Messages sent while it works; the loop reads them at its next step. */
  readonly inbox: Queue.Queue<Items.HistoryItem>
  /** Briefs so far, counting follow-ups; numbers the reports. */
  readonly briefs: Ref.Ref<number>
}

/**
 * Creates a chat's specialist runner.
 *
 * **Details**
 *
 * A run's brief loop is a fiber in `working`, keyed by run id, while it
 * works: a message for it steers it, and `stop` removes it. A finished run
 * stays for `warm`, so a message continues it, and is forgotten after. Every
 * time a run starts working it records `SpecialistStarted`, and when it
 * stops, however it stops, it reports `SpecialistFinished` through `report`:
 * answered, failed, stopped, or cut off.
 *
 * Each run works inside `holding`, which keeps the chat up while it does.
 * `stop` interrupts only the brief's loop, so the run still reports and lets
 * go; a shutdown interrupts the whole run, which reports that it was cut off
 * and keeps the hold, so the chat starts again and a turn reads the report.
 *
 * @internal
 */
export const makeRunner = Effect.fn(function* (options: {
  readonly chat: AssistantChat["Service"]
  readonly specialists: ReadonlyArray<{ readonly specialist: Specialist.Any; readonly handler: RunHandler }>
  readonly model: Context.Context<LanguageModel.LanguageModel>
  /** Keeps the chat up while the effect runs; an interruption keeps the hold. */
  readonly holding: (effect: Effect.Effect<void>) => Effect.Effect<void>
  /** Stores a run's report in the chat, and runs a turn for it. */
  readonly report: (finished: AssistantEvent.SpecialistFinished) => Effect.Effect<void>
}) {
  const { chat } = options
  const runs = new Map<string, Run>()
  const byName = new Map(options.specialists.map((entry) => [entry.specialist.name, entry]))
  // The brief loops working now, and the finished runs' countdowns to being forgotten.
  const working = yield* FiberMap.make<string, Outcome>()
  const forgetting = yield* FiberMap.make<string>()
  const background = yield* FiberSet.make()

  const report = Effect.fn(function* (run: Run, outcome: Outcome) {
    const brief = yield* Ref.get(run.briefs)

    yield* options.report(finished(run.specialist.name, { runId: run.runId, brief, goal: run.goal }, outcome))
  })

  const once = (run: Run) =>
    runBrief(run.handler, {
      specialist: run.specialist,
      runId: run.runId,
      brief: run.brief,
      history: run.history,
      inbox: run.inbox,
      chatId: chat.chatId
    }).pipe(
      Effect.provideContext(Context.merge(options.model, services)),
      Effect.match({
        onSuccess: (answer): Outcome => ({ status: "answered", report: answer }),
        onFailure: (error): Outcome => ({ status: "failed", error: String(error) })
      })
    )

  // A message that arrived after the last read: keep working before reporting.
  const untilCaughtUp = Effect.fn(function* (run: Run) {
    let outcome = yield* once(run)

    while ((yield* Queue.size(run.inbox)) > 0) outcome = yield* once(run)

    return outcome
  })

  /** Works on the brief, reports, and starts the countdown to forgetting the run. */
  const work = Effect.fn(
    function* (run: Run) {
      yield* chat.append([
        AssistantEvent.SpecialistStarted.make({ runId: run.runId, specialist: run.specialist.name, goal: run.goal })
      ])

      const exit = yield* Fiber.await(yield* FiberMap.run(working, run.runId, untilCaughtUp(run)))

      // Only `stop` interrupts the loop alone.
      yield* report(run, Exit.isSuccess(exit) ? exit.value : { status: "stopped" })
      yield* FiberMap.run(
        forgetting,
        run.runId,
        Effect.sleep(warm).pipe(Effect.andThen(Effect.sync(() => runs.delete(run.runId))))
      )
    },
    // A shutdown interrupts the whole run: no turn can start now, so the report waits for the chat's next start.
    (effect, run) => Effect.onInterrupt(effect, () => report(run, { status: "cut_off" }))
  )

  const launch = Effect.fn(function* (run: Run) {
    yield* FiberMap.remove(forgetting, run.runId)
    yield* FiberSet.run(background, options.holding(work(run)))
  })

  const runner = Specialist.Runner.of({
    spawn: Effect.fn(function* (request: Specialist.SpawnRequest) {
      const found = byName.get(request.kind)

      if (found === undefined) {
        return yield* Specialist.SpecialistError.make({ message: `No specialist named ${request.kind}.` })
      }

      const run: Run = {
        runId: yield* RunId.make,
        specialist: found.specialist,
        handler: found.handler,
        goal: request.brief.goal,
        brief: request.brief,
        history: yield* Ref.make<ReadonlyArray<Items.HistoryItem>>([Items.userText(briefText(request.brief))]),
        inbox: yield* Queue.unbounded<Items.HistoryItem>(),
        briefs: yield* Ref.make(1)
      }

      runs.set(run.runId, run)
      yield* launch(run)

      return run.runId
    }),
    message: Effect.fn(function* (
      runId: string,
      text: string
    ): Effect.fn.Return<"steered" | "continued", Specialist.SpecialistError> {
      const run = runs.get(runId)

      if (run === undefined) {
        return yield* Specialist.SpecialistError.make({
          message: `Run ${runId} is no longer available. Spawn a new one with the full context.`
        })
      }

      yield* Ref.update(run.briefs, (n) => n + 1)

      if (yield* FiberMap.has(working, runId)) {
        yield* Queue.offer(run.inbox, Items.userText(text))

        return "steered"
      }

      yield* Ref.update(run.history, (all) => [...all, Items.userText(text)])
      yield* launch(run)

      return "continued"
    }),
    stop: Effect.fn(function* (runId: string) {
      if (!(yield* FiberMap.has(working, runId))) {
        return yield* Specialist.SpecialistError.make({ message: `Run ${runId} isn't running.` })
      }

      yield* FiberMap.remove(working, runId)
    })
  })

  // What a run's handler gets: its chat, this runner, and (merged in `once`) the model.
  const services = Context.make(AssistantChat, chat).pipe(Context.add(Specialist.Runner, runner))

  return runner
})
