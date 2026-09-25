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
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import * as Predicate from "effect/Predicate"
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
 * Runs a specialist's handler on `history` until its loop ends, and returns
 * the answer: the last text the model wrote.
 *
 * **Details**
 *
 * The history is extended in place, so the same array can be continued with
 * a follow-up. Messages pushed to `inbox` while it runs join the history at
 * its next step. Each event the handler's stream emits is recorded before
 * the stream is pulled again, so the next step reads it.
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
      readonly history: Array<Items.HistoryItem>
      readonly inbox: Array<Items.HistoryItem>
      readonly chatId: AssistantChat["Service"]["chatId"]
    }
  ) {
    const { history, inbox } = options
    const answer = yield* Ref.make("")

    // Read before every model call, when no tool calls are open.
    const current = Effect.sync(() => {
      history.push(...inbox.splice(0))

      return [...history]
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
          ? Effect.sync(() => history.push(Items.toolCallOutput(event.callId, event.output)))
          : Effect.gen(function* () {
              history.push(...event.items)
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
const warmMillis = 15 * 60 * 1000

/** A run of the chat: one specialist's history, continued by follow-ups. */
interface Run {
  readonly runId: RunId.RunId
  readonly specialist: Specialist.Any
  readonly handler: RunHandler
  readonly goal: string
  readonly brief: Specialist.Brief
  readonly history: Array<Items.HistoryItem>
  /** Messages sent while it works; the loop reads them at its next step. */
  readonly inbox: Array<Items.HistoryItem>
  /** Briefs so far, counting follow-ups; numbers the reports. */
  briefs: number
  /** The brief's loop, while it works: `stop` interrupts it. */
  working: Fiber.Fiber<Outcome> | undefined
  lastUsed: number
}

/**
 * Creates a chat's specialist runner.
 *
 * **Details**
 *
 * Runs are fibers in a `FiberSet` in the chat's scope. A message for a
 * running run steers it; a message for a finished one continues it. Every
 * time a run starts working it records `SpecialistStarted`, and when it
 * stops, however it stops, it reports `SpecialistFinished` through
 * `report`: answered, failed, stopped, or cut off.
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
  const fibers = yield* FiberSet.make()
  const runs = new Map<string, Run>()
  const byName = new Map(options.specialists.map((entry) => [entry.specialist.name, entry]))

  const forgetOld = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis

    for (const [id, run] of runs) if (run.working === undefined && now - run.lastUsed > warmMillis) runs.delete(id)
  })

  const report = (run: Run, outcome: Outcome) =>
    options.report(finished(run.specialist.name, { runId: run.runId, brief: run.briefs, goal: run.goal }, outcome))

  /** Works on the brief until nothing new is in the inbox, then reports. */
  const work = Effect.fn(
    function* (run: Run) {
      yield* chat.append([
        AssistantEvent.SpecialistStarted.make({ runId: run.runId, specialist: run.specialist.name, goal: run.goal })
      ])

      const once = runBrief(run.handler, {
        specialist: run.specialist,
        runId: run.runId,
        brief: run.brief,
        history: run.history,
        inbox: run.inbox,
        chatId: chat.chatId
      }).pipe(
        Effect.provideContext(Context.merge(options.model, services)),
        Effect.match({
          onSuccess: (report): Outcome => ({ status: "answered", report }),
          onFailure: (error): Outcome => ({ status: "failed", error: String(error) })
        })
      )

      // A message that arrived after the last read: keep working before reporting.
      const loop = Effect.gen(function* () {
        let outcome = yield* once

        while (run.inbox.length > 0) outcome = yield* once

        return outcome
      })

      const working = yield* Effect.forkChild(loop)

      run.working = working

      const exit = yield* Fiber.await(working)

      run.working = undefined
      run.lastUsed = yield* Clock.currentTimeMillis

      // Only `stop` interrupts the loop alone.
      yield* report(run, Exit.isSuccess(exit) ? exit.value : { status: "stopped" })
    },
    // A shutdown interrupts the whole run: no turn can start now, so the report waits for the chat's next start.
    (effect, run) => Effect.onInterrupt(effect, () => report(run, { status: "cut_off" }))
  )

  const launch = (run: Run) => FiberSet.run(fibers, options.holding(work(run))).pipe(Effect.asVoid)

  const runner = Specialist.Runner.of({
    spawn: Effect.fn(function* (request: Specialist.SpawnRequest) {
      yield* forgetOld
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
        history: [Items.userText(briefText(request.brief))],
        inbox: [],
        briefs: 1,
        working: undefined,
        lastUsed: yield* Clock.currentTimeMillis
      }

      runs.set(run.runId, run)
      yield* launch(run)

      return run.runId
    }),
    message: Effect.fn(function* (runId: string, text: string) {
      yield* forgetOld
      const run = runs.get(runId)

      if (run === undefined) {
        return yield* Specialist.SpecialistError.make({
          message: `Run ${runId} is no longer available. Spawn a new one with the full context.`
        })
      }

      run.briefs += 1

      if (run.working !== undefined) {
        run.inbox.push(Items.userText(text))

        return "steered" as const
      }

      run.history.push(Items.userText(text))
      yield* launch(run)

      return "continued" as const
    }),
    stop: Effect.fn(function* (runId: string) {
      const working = runs.get(runId)?.working

      if (working === undefined) {
        return yield* Specialist.SpecialistError.make({ message: `Run ${runId} isn't running.` })
      }

      yield* Fiber.interrupt(working)
    })
  })

  // What a run's handler gets: its chat, this runner, and (merged in `work`) the model.
  const services = Context.make(AssistantChat, chat).pipe(Context.add(Specialist.Runner, runner))

  return runner
})
