import type * as LanguageModel from "effect/ai/LanguageModel"
import * as Prompt from "effect/ai/Prompt"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberMap from "effect/FiberMap"
import * as FiberSet from "effect/FiberSet"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as AssistantEvent from "../AssistantEvent.ts"
import type * as AssistantLoop from "../AssistantLoop.ts"
import * as Loop from "./loop.ts"
import { CurrentChat } from "../CurrentChat.ts"
import * as InputId from "../InputId.ts"
import * as RunId from "../RunId.ts"
import * as Skill from "../Skill.ts"
import * as Skills from "./skills.ts"
import * as Specialist from "../Specialist.ts"
import * as ToolFailure from "../ToolFailure.ts"
import * as Decisions from "./decisions.ts"
import { toolMessage, userText } from "./history.ts"
import { mapText } from "./instructions.ts"
import * as Telemetry from "./telemetry.ts"
import * as Toolkits from "./toolkit.ts"
import type { Writer } from "./writer.ts"

/** @internal */
export type RunHandler = (run: Specialist.Run) => Stream.Stream<AssistantLoop.Event, unknown, Specialist.RunServices>

/** @internal */
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

const finalText = (output: AssistantEvent.ModelOutput): string =>
  output.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim()

// The answer is the last text the model wrote.
/** @internal */
export const runBrief = Effect.fnUntraced(
  function* (
    handler: RunHandler,
    options: {
      readonly specialist: Specialist.Any
      readonly runId: RunId.RunId
      readonly brief: Specialist.Brief
      readonly history: Ref.Ref<ReadonlyArray<Prompt.Message>>
      readonly inbox: Queue.Queue<Prompt.Message>
      readonly chatId: Writer["chatId"]
    }
  ) {
    const { history, inbox } = options
    const answer = yield* Ref.make("")
    const add = (messages: ReadonlyArray<Prompt.Message>) => Ref.update(history, (all) => [...all, ...messages])

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

        return Loop.run({
          instructions: mapText(loop.instructions, (text) => Skill.withCatalog(text, skills)),
          toolkit: Toolkits.merge(Skills.toTools(skills), Toolkits.fromToolkitOrEmpty(loop.toolkit)),
          history: current,
          maxSteps: loop.maxSteps ?? 8
        })
      }
    }

    // A run lives in memory, so there's nothing to run again after a crash: `ToolStarted` isn't kept. A run parks no
    // call (it has no user to ask), so there's no `DecisionRequested` either.
    const record = Effect.fnUntraced(function* (event: AssistantLoop.Event) {
      if (Predicate.isTagged(event, "ToolStarted") || Predicate.isTagged(event, "DecisionRequested")) return

      if (Predicate.isTagged(event, "ToolResult")) return yield* add([toolMessage(event)])

      yield* add(Prompt.fromResponseParts(event.parts).content)
      const text = finalText(event)

      if (text.length > 0) yield* Ref.set(answer, text)
    })

    yield* Stream.runForEach(handler(run), record)

    const text = yield* Ref.get(answer)

    yield* Telemetry.agentOutput(text)

    return text
  },
  (effect, _handler, options) => effect.pipe(Telemetry.agentSpan(options.specialist.name, { chatId: options.chatId }))
)

type Outcome =
  | { readonly status: "answered"; readonly report: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "stopped" | "cut_off" }

// Only `stop` interrupts a brief's loop alone; a failure or a defect failed it.
const unanswered = (cause: Cause.Cause<unknown>): Outcome =>
  Cause.hasInterruptsOnly(cause) ? { status: "stopped" } : { status: "failed", error: String(Cause.squash(cause)) }

// The id is fixed per run and brief, so a replay is stored once.
/** @internal */
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

const RunIdInput = RunId.RunId.annotate({ description: "The runId spawn_specialist returned." })

const RunStatus = <const Status extends string>(status: ReadonlyArray<Status>) =>
  Schema.Struct({ runId: RunId.RunId, status: Schema.Literals(status) })

const MessageSpecialist = Tool.make("message_specialist", {
  description:
    "Send more to one of your specialists: new instructions for a running one (it reads them at its next step), or a follow-up for a finished one (it continues with what it already found).",
  parameters: Schema.Struct({ runId: RunIdInput, message: Schema.String }),
  success: RunStatus(["steered", "continued"]),
  failure: ToolFailure.ToolFailure,
  dependencies: [Specialist.Runner]
})

const StopSpecialist = Tool.make("stop_specialist", {
  description:
    "Stop one of your running specialists, for example when the user changed their mind. It posts no answer.",
  parameters: Schema.Struct({ runId: RunIdInput }),
  success: RunStatus(["stopped"]),
  failure: ToolFailure.ToolFailure,
  dependencies: [Specialist.Runner]
})

const refused = <A, R>(effect: Effect.Effect<A, Specialist.SpecialistError, R>) =>
  Effect.catch(effect, (error) => ToolFailure.fail(error.message, { reason: error.reason }))

/** @internal */
export const toolkit = Effect.fnUntraced(function* (
  specialists: ReadonlyArray<Specialist.Any>
): Effect.fn.Return<Toolkits.Tools<Specialist.Runner>> {
  if (specialists.length === 0) return Toolkits.empty

  const catalog = specialists.map((specialist) => `- ${specialist.name}: ${specialist.description}`).join("\n")

  const SpawnSpecialist = Tool.make("spawn_specialist", {
    description: `Start a specialist on a job. It works in the background and its report arrives as a <specialist> input, often within seconds. Write a self-contained brief: it can't see this chat. For a quick question, just call wait; for slow work, tell the user in one line first.\nPass one of these as specialist:\n${catalog}`,
    parameters: Schema.Struct({
      specialist: Schema.Literals(specialists.map((specialist) => specialist.name)).annotate({
        description: "The specialist to start, by name."
      }),
      ...Specialist.Brief.fields
    }),
    success: RunStatus(["started"]),
    failure: ToolFailure.ToolFailure,
    dependencies: [Specialist.Runner]
  })

  const SpecialistTools = Toolkit.make(SpawnSpecialist, MessageSpecialist, StopSpecialist)

  const handlers = yield* SpecialistTools.toHandlers({
    spawn_specialist: Effect.fnUntraced(function* ({ specialist, ...brief }) {
      const runId = yield* refused(Specialist.Runner.use((runner) => runner.spawn({ specialist, brief })))

      return { runId, status: "started" }
    }),
    message_specialist: Effect.fnUntraced(function* ({ runId, message }) {
      const status = yield* refused(Specialist.Runner.use((runner) => runner.message(runId, message)))

      return { runId, status }
    }),
    stop_specialist: Effect.fnUntraced(function* ({ runId }) {
      yield* refused(Specialist.Runner.use((runner) => runner.stop(runId)))

      return { runId, status: "stopped" }
    })
  })

  return Toolkits.fromWithHandler(yield* Effect.provideContext(SpecialistTools, handlers))
})

// How long a finished run stays available for follow-ups.
const warm = "15 minutes"

interface Run {
  readonly runId: RunId.RunId
  readonly specialist: Specialist.Any
  readonly handler: RunHandler
  readonly goal: string
  readonly brief: Specialist.Brief
  readonly history: Ref.Ref<ReadonlyArray<Prompt.Message>>
  // Messages sent while it works; the loop reads them at its next step.
  readonly inbox: Queue.Queue<Prompt.Message>
  // Counts follow-ups too; numbers the reports.
  readonly briefs: Ref.Ref<number>
  // Read and changed under `lock`.
  readonly busy: Ref.Ref<boolean>
  // Orders a message against the run finishing, so none is dropped or starts a second loop.
  readonly lock: Semaphore.Semaphore
}

/** @internal */
export const makeRunner = Effect.fnUntraced(function* (options: {
  readonly chat: Writer
  readonly handle: CurrentChat["Service"]
  readonly specialists: ReadonlyArray<{
    readonly specialist: Specialist.Any
    readonly handler: RunHandler
  }>
  readonly model: Context.Context<LanguageModel.LanguageModel>
  // An interruption keeps the hold.
  readonly holding: (effect: Effect.Effect<void>) => Effect.Effect<void>
  readonly report: (finished: AssistantEvent.SpecialistFinished) => Effect.Effect<void>
}) {
  const { chat } = options
  const runs = new Map<string, Run>()
  const byName = new Map(options.specialists.map((entry) => [entry.specialist.name, entry]))
  // The brief loops working now, and the finished runs' countdowns to being forgotten.
  const working = yield* FiberMap.make<string, Outcome>()
  const forgetting = yield* FiberMap.make<string>()
  const background = yield* FiberSet.make()

  const report = Effect.fnUntraced(function* (run: Run, outcome: Outcome) {
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
      // Spawned from a turn, a run would inherit the turn's decisions: it can't park a call or run an approved one.
      Effect.provideService(Decisions.TurnDecisions, Option.none()),
      // Nor its own tools: a run can't message the user.
      Effect.provideService(Loop.TurnTools, Option.none()),
      Effect.matchCause({
        onSuccess: (answer): Outcome => ({ status: "answered", report: answer }),
        onFailure: unanswered
      })
    )

  // A message that arrived after the last read: keep working before reporting.
  const untilCaughtUp = Effect.fnUntraced(function* (run: Run) {
    let outcome = yield* once(run)

    while ((yield* Queue.size(run.inbox)) > 0) outcome = yield* once(run)

    return outcome
  })

  const work = Effect.fnUntraced(
    function* (run: Run) {
      yield* chat.append([
        AssistantEvent.SpecialistStarted.make({
          runId: run.runId,
          specialist: run.specialist.name,
          goal: run.goal
        })
      ])

      let finished = false

      while (!finished) {
        const exit = yield* Fiber.await(yield* FiberMap.run(working, run.runId, untilCaughtUp(run)))
        const outcome = Exit.isSuccess(exit) ? exit.value : unanswered(exit.cause)

        finished = yield* run.lock.withPermit(
          Effect.gen(function* () {
            // A message steered in after the loop's last read: work on it before reporting.
            if (outcome.status !== "stopped" && (yield* Queue.size(run.inbox)) > 0) return false

            yield* report(run, outcome)
            yield* Ref.set(run.busy, false)
            yield* FiberMap.run(
              forgetting,
              run.runId,
              Effect.gen(function* () {
                yield* Effect.sleep(warm)
                runs.delete(run.runId)
              })
            )

            return true
          })
        )
      }
    },
    // A shutdown interrupts the whole run: no turn can start now, so the report waits for the chat's next start.
    (effect, run) => Effect.onInterrupt(effect, () => report(run, { status: "cut_off" }))
  )

  const launch = Effect.fnUntraced(function* (run: Run) {
    yield* FiberMap.remove(forgetting, run.runId)
    yield* FiberSet.run(background, options.holding(work(run)))
  })

  // Under the run's lock.
  const send = Effect.fnUntraced(function* (run: Run, text: string): Effect.fn.Return<"steered" | "continued"> {
    yield* Ref.update(run.briefs, (n) => n + 1)

    if (yield* Ref.get(run.busy)) {
      yield* Queue.offer(run.inbox, userText(text))

      return "steered"
    }

    yield* Ref.update(run.history, (all) => [...all, userText(text)])
    yield* Ref.set(run.busy, true)
    yield* launch(run)

    return "continued"
  })

  const runner = Specialist.Runner.of({
    spawn: Effect.fnUntraced(function* (request: Specialist.SpawnRequest) {
      const found = byName.get(request.specialist)

      if (found === undefined) {
        return yield* new Specialist.SpecialistError({
          reason: "UnknownSpecialist",
          message: `No specialist named ${request.specialist}.`
        })
      }

      const run: Run = {
        runId: yield* RunId.make(),
        specialist: found.specialist,
        handler: found.handler,
        goal: request.brief.goal,
        brief: request.brief,
        history: yield* Ref.make<ReadonlyArray<Prompt.Message>>([userText(briefText(request.brief))]),
        inbox: yield* Queue.unbounded<Prompt.Message>(),
        briefs: yield* Ref.make(1),
        busy: yield* Ref.make(true),
        lock: yield* Semaphore.make(1)
      }

      runs.set(run.runId, run)
      yield* launch(run)

      return run.runId
    }),
    message: Effect.fnUntraced(function* (
      runId: RunId.RunId,
      text: string
    ): Effect.fn.Return<"steered" | "continued", Specialist.SpecialistError> {
      const run = runs.get(runId)

      if (run === undefined) {
        return yield* new Specialist.SpecialistError({
          reason: "RunNotFound",
          message: `Run ${runId} is no longer available. Spawn a new one with the full context.`
        })
      }

      return yield* run.lock.withPermit(send(run, text))
    }),
    stop: Effect.fnUntraced(function* (runId: RunId.RunId) {
      if (!(yield* FiberMap.has(working, runId))) {
        return yield* new Specialist.SpecialistError({ reason: "NotRunning", message: `Run ${runId} isn't running.` })
      }

      yield* FiberMap.remove(working, runId)
    })
  })

  // What a run's handler gets: its chat, this runner, and (merged in `once`) the model.
  const services = Context.make(CurrentChat, options.handle).pipe(Context.add(Specialist.Runner, runner))

  return runner
})
