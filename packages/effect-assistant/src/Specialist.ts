/**
 * The `Specialist` module defines specialists: focused agents an assistant
 * hands work to, in the background.
 *
 * A specialist has two parts, like a workflow:
 *
 * - **Definition**: {@link make} names it and says when to use it (the
 *   assistant sees this). An assistant lists the specialists it can use in
 *   its own definition.
 * - **Handler**: `toLayer` takes a function of the {@link Run} that returns
 *   the run's loop as a stream, usually `run.loop({ model, instructions, toolkit })`.
 *   The build Effect runs once per chat activation, like an entity's, with
 *   the layer's services and `AssistantChat`; the function runs for each
 *   brief. A run works in the chat that spawned it:
 *   look up whom it works for from `run.chatId`, like the assistant's
 *   handler does.
 *
 * The assistant works with its specialists through three tools:
 *
 * - `spawn_specialist({ kind, goal, ... })` starts a run with a {@link Brief}
 *   and returns its `runId`. The run works in the background and reports
 *   back: its report arrives as a `SpecialistFinished` input, usually
 *   within the same turn for quick questions, and the assistant decides what
 *   to tell the user.
 * - `message_specialist({ runId, message })` sends a run more: a running one
 *   reads it at its next step (steering), a finished one continues with
 *   everything it found so far (follow-up).
 * - `stop_specialist({ runId })` interrupts a running one.
 *
 * Specialists answer in plain text (the last text the model writes) and
 * can't message the user. Runs live with their chat: a restart cuts them
 * off (the assistant is told), and a finished run is forgotten after 15
 * minutes.
 *
 * **Example** (A research specialist)
 *
 * ```ts
 * import * as Toolkit from "@effect-uai/core/Toolkit"
 * import * as Effect from "effect/Effect"
 * import * as Stream from "effect/Stream"
 * import { Assistant, Specialist } from "effect-assistant"
 * import { ChatUsers, CurrentUser } from "./CurrentUser.ts"
 * import { orderHistory, similarCampaigns } from "./tools.ts" // tools that yield CurrentUser
 *
 * const Research = Specialist.make("research", {
 *   description: "Researches past campaigns and orders. Give it the question and any context."
 * })
 *
 * const ResearchLive = Research.toLayer(Effect.gen(function*() {
 *   const users = yield* ChatUsers // the app's: whose chat is it
 *
 *   return (run) =>
 *     Stream.unwrap(Effect.map(users.forChat(run.chatId), (user) =>
 *       run.loop({
 *         model: "claude-sonnet-5",
 *         instructions: "Answer with the findings and numbers the colleague needs, in a few short lines.",
 *         toolkit: Toolkit.make(similarCampaigns, orderHistory)
 *       }).pipe(Stream.provideService(CurrentUser, user))))
 * }))
 *
 * const MyAssistant = Assistant.make("my-assistant", { specialists: [Research] })
 * ```
 *
 * @since 0.1.0
 */
import type * as AiError from "@effect-uai/core/AiError"
import type * as Items from "@effect-uai/core/Items"
import type * as LanguageModel from "@effect-uai/core/LanguageModel"
import type * as Toolkit from "@effect-uai/core/Toolkit"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import type { AssistantChat } from "./AssistantChat.ts"
import type * as AssistantLoop from "./AssistantLoop.ts"
import type { AssistantToolCall } from "./AssistantToolCall.ts"
import type { AssistantTurn } from "./AssistantTurn.ts"
import type { ChatId } from "./ChatId.ts"
import type * as ChatLog from "./ChatLog.ts"
import type * as Instructions from "./Instructions.ts"
import type { RunId } from "./RunId.ts"
import type { Skill } from "./Skill.ts"

const TypeId = "~effect-assistant/Specialist"

/**
 * A specialist's definition.
 *
 * @category models
 * @since 0.1.0
 */
export interface Specialist<Name extends string = string> {
  readonly [TypeId]: typeof TypeId
  readonly name: Name
  /** When to use it. The assistant sees this. */
  readonly description: string
  /** The specialist's handler, as `toLayer` provides it. */
  readonly Handler: Context.Key<SpecialistHandler<Name>, Built>
  /**
   * Provides the specialist's handler. The handler may use the
   * {@link RunServices} and services its build Effect required (see
   * {@link CheckServices}).
   */
  readonly toLayer: <R = never, RE = never, E = never, RX = never>(
    build:
      & (Handler<R, RE> | Effect.Effect<Handler<R, RE>, E, RX>)
      & CheckServices<Exclude<R | RE, RunServices | RX>>
  ) => Layer.Layer<SpecialistHandler<Name>, never, Exclude<RX, Scope.Scope | AssistantChat>>
}

/**
 * What `toLayer` checks a handler against: every service it uses must be one
 * the run (or turn) provides, or one its build Effect required (the layer
 * provides those). A handler that uses anything else gets this error, naming
 * the services.
 *
 * **Details**
 *
 * The build Effect runs once, with the layer's services; the handler runs for
 * every brief (or turn). Like Effect AI's `Tool` handlers, the handler can't
 * reach for a service nothing provides: yield it in the build Effect, or
 * provide it to the loop yourself, like a user looked up from the chat.
 *
 * @category utility types
 * @since 0.1.0
 */
export type CheckServices<Undeclared> = [Undeclared] extends [never] ? unknown : {
  readonly "~undeclaredServices": {
    readonly error: "The handler uses services that neither the turn provides nor its build Effect requires"
    readonly services: Undeclared
  }
}

/**
 * Any specialist.
 *
 * @category models
 * @since 0.1.0
 */
export type Any = Specialist<any>

/**
 * Identifies a specialist's handler in a context.
 *
 * @category models
 * @since 0.1.0
 */
export interface SpecialistHandler<Name extends string> {
  readonly _SpecialistHandler: Name
}

/**
 * Returns the handlers these specialists need.
 *
 * @category utility types
 * @since 0.1.0
 */
export type HandlerOf<S> = S extends Specialist<infer Name> ? SpecialistHandler<Name> : never

/**
 * Services a run provides to its handler: the spawning turn, the runner, the
 * chat's log, and the model.
 *
 * @category models
 * @since 0.1.0
 */
export type RunServices =
  | AssistantTurn
  | Runner
  | ChatLog.ChatLog
  | LanguageModel.LanguageModel

/**
 * Options for `run.loop`.
 *
 * @category models
 * @since 0.1.0
 */
export interface LoopOptions<Tools extends Toolkit.Toolkit, R> {
  /** The model to call, as the `LanguageModel` in context names it (e.g. `"claude-haiku-4-5"`). */
  readonly model: string
  readonly instructions: string | Instructions.Resolved
  readonly toolkit?: Tools | undefined
  /** Playbooks: a catalog in the prompt, loaded with `load_skill` when a task matches. */
  readonly skills?: ReadonlyArray<Skill<R>> | undefined
  /** Model calls per brief. Default 8. */
  readonly maxSteps?: number | undefined
}

/**
 * One run of a specialist on a brief, as its handler sees it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Run {
  readonly runId: RunId
  /** The chat it works in: the spawning turn's. */
  readonly chatId: ChatId
  readonly brief: Brief
  /**
   * The run's history: the brief, what it did so far, and messages sent to
   * it since (follow-ups, steering). Read it before every model call; the
   * loop does.
   */
  readonly history: Effect.Effect<ReadonlyArray<Items.HistoryItem>>
  /** The agent loop over the run's history, with these instructions, tools, and skills. */
  readonly loop: <Tools extends Toolkit.Toolkit = Record<never, never>, R = never>(
    options: LoopOptions<Tools, R>
  ) => Stream.Stream<
    AssistantLoop.Event,
    AiError.AiError,
    LanguageModel.LanguageModel | Exclude<Toolkit.ToolkitR<Tools>, AssistantToolCall> | R
  >
}

/**
 * A specialist's handler: runs a brief, as a stream of what the loop did. It
 * may return the stream from an Effect. `R` is what the stream needs, `RE`
 * what the Effect needs.
 *
 * @category models
 * @since 0.1.0
 */
export type Handler<R = never, RE = R> = (
  run: Run
) =>
  | Stream.Stream<AssistantLoop.Event, unknown, R>
  | Effect.Effect<Stream.Stream<AssistantLoop.Event, unknown, R>, unknown, RE>

/**
 * A handler's build, with the services of the layer that registered it. The
 * build runs once per chat activation (see `AssistantChat`).
 *
 * @category models
 * @since 0.1.0
 */
export interface Built {
  readonly build: Effect.Effect<Handler<any, any>, unknown, any>
  readonly context: Context.Context<never>
}

/**
 * Defines a specialist: its name, and when to use it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <const Name extends string>(
  name: Name,
  options: {
    /** When to use it. The assistant sees this. */
    readonly description: string
  }
): Specialist<Name> => {
  const Handler = Context.Service<SpecialistHandler<Name>, Built>(`effect-assistant/Specialist/${name}`)

  // The build runs per chat activation, in the chat; here it only keeps the layer's services for it.
  const toLayer = (build: Handler<any, any> | Effect.Effect<Handler<any, any>, any, any>) =>
    Layer.effect(
      Handler,
      Effect.map(Effect.context<never>(), (context) => ({
        build: Effect.isEffect(build) ? build : Effect.succeed(build),
        context
      }))
    )

  return {
    [TypeId]: TypeId,
    name,
    description: options.description,
    Handler,
    // SAFETY: the layer provides the handler it's given; its requirements are the ones `toLayer` states.
    toLayer: toLayer as Specialist<Name>["toLayer"]
  }
}

/**
 * Schema for what the assistant tells a specialist. Only `goal` is required.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Brief = Schema.Struct({
  goal: Schema.String.annotate({ description: "What to find out or do." }),
  context: Schema.optional(Schema.String).annotate({
    description: "What it needs to know. It can't see this chat."
  }),
  successCriteria: Schema.optional(Schema.String).annotate({ description: "When it is done." }),
  report: Schema.optional(Schema.String).annotate({ description: "What to put in the answer, and how." }),
  limits: Schema.optional(Schema.String).annotate({
    description: "Hard limits for this job, like read-only or a deadline."
  })
})

/**
 * A brief.
 *
 * @category models
 * @since 0.1.0
 */
export type Brief = typeof Brief.Type

/**
 * A request to start a specialist run.
 *
 * @category models
 * @since 0.1.0
 */
export interface SpawnRequest {
  /** The turn that spawns it: the run works in its chat. */
  readonly turn: AssistantTurn["Service"]
  /** The specialist's name. */
  readonly kind: string
  readonly brief: Brief
}

/**
 * Why a run request can't be done, written for the model: an unknown
 * specialist, a run that's gone, or one that isn't running.
 *
 * @category errors
 * @since 0.1.0
 */
export class SpecialistError extends Schema.TaggedError<SpecialistError>()("SpecialistError", {
  message: Schema.String
}) {}

/**
 * Service that runs a chat's specialists and keeps finished runs warm for
 * follow-ups. The engine provides it to every turn: the specialist tools use
 * it, and so can a handler.
 *
 * @category services
 * @since 0.1.0
 */
export class Runner extends Context.Service<Runner, {
  /** Starts a run and returns its id. */
  readonly spawn: (request: SpawnRequest) => Effect.Effect<RunId, SpecialistError>
  /** Steers a running run, or continues a finished one. */
  readonly message: (runId: string, text: string) => Effect.Effect<"steered" | "continued", SpecialistError>
  /** Interrupts a running run. */
  readonly stop: (runId: string) => Effect.Effect<void, SpecialistError>
}>()("effect-assistant/Specialist/Runner") {}
