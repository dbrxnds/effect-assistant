/**
 * Running specialists: a brief's loop, the specialist tools, and the
 * in-memory runner assistants provide.
 *
 * @since 0.1.0
 * @internal
 */
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as AssistantEvent from "../AssistantEvent.ts"
import * as AssistantLoop from "../AssistantLoop.ts"
import { AssistantTurn } from "../AssistantTurn.ts"
import type { ChatId } from "../ChatId.ts"
import * as InputId from "../InputId.ts"
import type * as Instructions from "../Instructions.ts"
import * as RunId from "../RunId.ts"
import * as Skill from "../Skill.ts"
import * as Specialist from "../Specialist.ts"
import * as Telemetry from "./telemetry.ts"

/**
 * A specialist's handler, its build already run for the chat, with the
 * services of the layer that registered it.
 *
 * @internal
 */
export interface Opened {
  readonly handler: Specialist.Handler<any, any>
  readonly context: Context.Context<never>
}

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
    .flatMap((item) => Items.isMessage(item) && item.role === "assistant" ? item.content : [])
    .flatMap((content) => Items.isOutputText(content) ? [content.text] : [])
    .join("")
    .trim()

/** Instructions with the skills' catalog appended. */
const withSkills = (
  instructions: string | Instructions.Resolved,
  skills: ReadonlyArray<Skill.Skill<any>>
): Instructions.Resolved =>
  Predicate.isString(instructions)
    ? { text: Skill.withCatalog(instructions, skills) }
    : { ...instructions, text: Skill.withCatalog(instructions.text, skills) }

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
export const run = Effect.fn(
  function*(
    _specialist: Specialist.Any,
    built: Opened,
    options: {
      readonly runId: RunId.RunId
      readonly brief: Specialist.Brief
      readonly history: Array<Items.HistoryItem>
      readonly inbox: Array<Items.HistoryItem>
      readonly chatId: ChatId
    }
  ) {
    const { history, inbox } = options
    let answer = ""

    // Read before every model call, when no tool calls are open.
    const current = Effect.sync(() => {
      history.push(...inbox.splice(0))

      return [...history]
    })

    const handlerRun: Specialist.Run = {
      runId: options.runId,
      chatId: options.chatId,
      brief: options.brief,
      history: current,
      loop: (loop) => {
        const skills = loop.skills ?? []

        return AssistantLoop.stream({
          model: loop.model,
          instructions: withSkills(loop.instructions, skills),
          toolkit: { ...Skill.toolkit(skills), ...loop.toolkit },
          history: current,
          maxSteps: loop.maxSteps ?? 8
        })
      }
    }

    const record = (event: AssistantLoop.Event) =>
      Effect.sync(() => {
        // A run lives in memory, so there's nothing to run again after a crash.
        if (Predicate.isTagged(event, "ToolStarted")) return

        if (Predicate.isTagged(event, "ToolResult")) {
          history.push(Items.toolCallOutput(event.callId, event.output))

          return
        }

        history.push(...event.items)
        const text = finalText(event.items)

        if (text.length > 0) answer = text
      })

    const result = built.handler(handlerRun)
    const events = Effect.isEffect(result) ? Stream.unwrap(result) : result

    // SAFETY: the handler's layer context provides what it needs beyond the run services.
    yield* (events.pipe(Stream.runForEach(record)) as Effect.Effect<void, unknown>).pipe(
      Effect.provide(built.context)
    )
    yield* Telemetry.agentOutput(answer)

    return answer
  },
  (effect, specialist, _built, options) => effect.pipe(Telemetry.agentSpan(specialist.name, { chatId: options.chatId }))
)

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
    id: InputId.make(`${run.runId}:${run.brief}`),
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
  // SAFETY: there is at least one specialist (checked above).
  const kinds = specialists.map((specialist) => specialist.name) as [string, ...Array<string>]
  const RunIdInput = Schema.String.annotate({ description: "The runId spawn_specialist returned." })

  const fail = <A>(effect: Effect.Effect<A, Specialist.SpecialistError>) =>
    effect.pipe(Effect.catch((error) => Tool.fail(error.message)))

  const SpawnInput = Schema.Struct({ kind: Schema.Literals(kinds), ...Specialist.Brief.fields })

  const spawn = Tool.make({
    name: "spawn_specialist",
    description:
      `Start a specialist on a job. It works in the background and its report arrives as a <specialist> input, often within seconds. Write a self-contained brief: it can't see this chat. For a quick question, just call wait; for slow work, tell the user in one line first.\n${catalog}`,
    inputSchema: SpawnInput,
    run: Effect.fn(function*({ kind, ...brief }: typeof SpawnInput.Type) {
      const turn = yield* AssistantTurn
      const runner = yield* Specialist.Runner
      const runId = yield* fail(runner.spawn({ turn, kind, brief }))

      return { runId, status: "started" }
    })
  })

  const MessageInput = Schema.Struct({ runId: RunIdInput, message: Schema.String })

  const message = Tool.make({
    name: "message_specialist",
    description:
      "Send more to one of your specialists: new instructions for a running one (it reads them at its next step), or a follow-up for a finished one (it continues with what it already found).",
    inputSchema: MessageInput,
    run: Effect.fn(function*({ runId, message }: typeof MessageInput.Type) {
      const runner = yield* Specialist.Runner

      return { runId, status: yield* fail(runner.message(runId, message)) }
    })
  })

  const StopInput = Schema.Struct({ runId: RunIdInput })

  const stop = Tool.make({
    name: "stop_specialist",
    description:
      "Stop one of your running specialists, for example when the user changed their mind. It posts no answer.",
    inputSchema: StopInput,
    run: Effect.fn(function*({ runId }: typeof StopInput.Type) {
      const runner = yield* Specialist.Runner
      yield* fail(runner.stop(runId))

      return { runId, status: "stopped" }
    })
  })

  return Toolkit.make(spawn, message, stop)
}

/** How long a finished run stays available for follow-ups. */
const warmMillis = 15 * 60 * 1000

interface Run {
  readonly specialist: Specialist.Any
  readonly built: Opened
  /** The turn that spawned it: its chat. */
  readonly turn: AssistantTurn["Service"]
  readonly history: Array<Items.HistoryItem>
  /** Messages sent while it runs; the loop reads them at its next step. */
  readonly inbox: Array<Items.HistoryItem>
  /** Briefs so far, counting follow-ups; numbers the answer facts. */
  briefs: number
  readonly brief: Specialist.Brief
  readonly goal: string
  fiber: Fiber.Fiber<void> | undefined
  /** Set by `stop`, so the interruption isn't reported as a lost run. */
  stopping: boolean
  lastUsed: number
}

/**
 * Creates a chat's specialist runner.
 *
 * **Details**
 *
 * Runs are fibers in a `FiberSet` in the chat's scope. A message for a
 * running run steers it; a message for a finished one continues it. Each
 * answer goes to the chat through `answer`, which stores it and runs a turn
 * for it. `context` provides the model and whatever the specialists' tools
 * need, plus the turn services.
 *
 * Every time a run starts working it records `SpecialistStarted`, and when it
 * stops, however it stops, `SpecialistFinished`: answered, failed, stopped,
 * or cut off. `keepAlive(true)` is called
 * when the first run starts working, and `keepAlive(false)` when the last one
 * is done, so the chat's entity stays up for them. A run interrupted by
 * anything but `stop` (a shutdown) answers that it was cut off, and leaves
 * the keep-alive on: the cluster starts the entity again, which runs a turn
 * for the answer.
 *
 * @internal
 */
export const makeRunner = Effect.fn(function*(options: {
  readonly specialists: ReadonlyArray<{ readonly specialist: Specialist.Any; readonly built: Opened }>
  readonly context: () => Context.Context<never>
  /** Stores a run's answer in the chat, and runs a turn for it. */
  readonly answer: (chatId: ChatId, finished: AssistantEvent.SpecialistFinished) => Effect.Effect<void>
  /** Appends a run's start or end to the chat's log. */
  readonly record: (
    chatId: ChatId,
    event: AssistantEvent.SpecialistStarted
  ) => Effect.Effect<void>
  /** Keeps the chat up while runs work. */
  readonly keepAlive: (enabled: boolean) => Effect.Effect<void>
}) {
  const fibers = yield* FiberSet.make()
  const runs = new Map<string, Run>()
  const byName = new Map(options.specialists.map((entry) => [entry.specialist.name, entry]))
  // Runs working now.
  let working = 0

  const forgetOld = () => {
    const now = Date.now()

    for (const [id, entry] of runs) if (entry.fiber === undefined && now - entry.lastUsed > warmMillis) runs.delete(id)
  }

  /** Works until the inbox is empty, then posts the answer. */
  const work = Effect.fn(
    function*(runId: RunId.RunId, entry: Run) {
      // SAFETY: `context` provides the model and the turn services.
      const provided = run(entry.specialist, entry.built, {
        runId,
        brief: entry.brief,
        history: entry.history,
        inbox: entry.inbox,
        chatId: entry.turn.chatId
      }).pipe(
        Effect.provideService(AssistantTurn, entry.turn),
        Effect.provide(options.context())
      ) as Effect.Effect<string, unknown>

      const once = provided.pipe(
        Effect.match({
          onSuccess: (report): Outcome => ({ status: "answered", report }),
          onFailure: (error): Outcome => ({ status: "failed", error: String(error) })
        })
      )

      let outcome = yield* once

      // A message that arrived after the last read: keep working before answering.
      while (entry.inbox.length > 0) outcome = yield* once

      yield* options.answer(
        entry.turn.chatId,
        finished(entry.specialist.name, { runId, brief: entry.briefs, goal: entry.goal }, outcome)
      )
    },
    (effect, runId, entry) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function*() {
            entry.fiber = undefined
            entry.lastUsed = Date.now()
            const chatId = entry.turn.chatId
            const cutOff = Exit.hasInterrupts(exit) && !entry.stopping

            const run = { runId, brief: entry.briefs, goal: entry.goal }

            // During a shutdown no turn can start: the report waits for the chat's next start. A run the
            // assistant stopped is recorded too; it starts no turn. A run that answered already reported.
            if (cutOff) yield* options.answer(chatId, finished(entry.specialist.name, run, { status: "cut_off" }))
            else if (entry.stopping) {
              yield* options.answer(chatId, finished(entry.specialist.name, run, { status: "stopped" }))
            }

            working -= 1

            // A cut-off run leaves the keep-alive on, so the chat starts again and tells the user.
            if (working === 0 && !cutOff) yield* options.keepAlive(false)
          })
        )
      )
  )

  const launch = Effect.fn(function*(runId: RunId.RunId, entry: Run) {
    entry.stopping = false
    yield* options.record(
      entry.turn.chatId,
      AssistantEvent.SpecialistStarted.make({ runId, specialist: entry.specialist.name, goal: entry.goal })
    )
    working += 1

    if (working === 1) yield* options.keepAlive(true)

    entry.fiber = yield* FiberSet.run(fibers, work(runId, entry))
  })

  return Specialist.Runner.of({
    spawn: Effect.fn(function*(request: Specialist.SpawnRequest) {
      forgetOld()
      const found = byName.get(request.kind)

      if (found === undefined) {
        return yield* Specialist.SpecialistError.make({ message: `No specialist named ${request.kind}.` })
      }

      const runId = RunId.make()

      const entry: Run = {
        specialist: found.specialist,
        built: found.built,
        turn: request.turn,
        history: [Items.userText(briefText(request.brief))],
        inbox: [],
        briefs: 1,
        brief: request.brief,
        goal: request.brief.goal,
        fiber: undefined,
        stopping: false,
        lastUsed: Date.now()
      }

      runs.set(runId, entry)
      yield* launch(runId, entry)

      return runId
    }),
    message: Effect.fn(function*(runId: string, text: string) {
      forgetOld()
      const entry = runs.get(runId)

      if (entry === undefined) {
        return yield* Specialist.SpecialistError.make({
          message: `Run ${runId} is no longer available. Spawn a new one with the full context.`
        })
      }

      entry.briefs += 1

      if (entry.fiber !== undefined) {
        entry.inbox.push(Items.userText(text))

        return "steered" as const
      }

      entry.history.push(Items.userText(text))
      // SAFETY: only ids minted by `spawn` are keys of `runs`.
      yield* launch(runId as RunId.RunId, entry)

      return "continued" as const
    }),
    stop: Effect.fn(function*(runId: string) {
      const entry = runs.get(runId)

      if (entry?.fiber === undefined) {
        return yield* Specialist.SpecialistError.make({ message: `Run ${runId} isn't running.` })
      }

      entry.stopping = true
      yield* Fiber.interrupt(entry.fiber)
    })
  })
})
