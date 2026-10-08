/**
 * Defines specialists, which are focused agents an assistant hands work to in the background.
 *
 * A specialist has a definition, created with {@link make}, that gives its name and when to use
 * it, and a handler, provided with its `toLayer`, that works on a {@link Brief} as a loop. The
 * {@link Runner} service starts, steers, and stops a chat's specialist runs.
 *
 * @since 0.1.0
 */
import type * as AiError from "effect/ai/AiError"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Prompt from "effect/ai/Prompt"
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { AssistantChat } from "./AssistantChat.ts"
import type * as AssistantLoop from "./AssistantLoop.ts"
import type { ChatId } from "./ChatId.ts"
import type * as Instructions from "./Instructions.ts"
import type { RunId } from "./RunId.ts"
import type { Skill } from "./Skill.ts"

const TypeId = "~effect-assistant/Specialist"

/**
 * Represents a specialist's definition.
 *
 * @category models
 * @since 0.1.0
 */
export interface Specialist<Name extends string = string> {
  readonly [TypeId]: typeof TypeId
  readonly name: Name
  /** When to use the specialist. The assistant sees this. */
  readonly description: string
  /** The key of the specialist's handler, as `toLayer` provides it. */
  readonly Handler: Context.Key<SpecialistHandler<Name>, Built>
  /**
   * Provides the specialist's handler. The handler may use the {@link RunServices} and the
   * services its build Effect required (see {@link CheckServices}).
   */
  readonly toLayer: <R = never, RE = never, E = never, RX = never>(
    build: (Handler<R, RE> | Effect.Effect<Handler<R, RE>, E, RX>) &
      CheckServices<Exclude<R | RE, RunServices | RX | Tool.Handler<string>>>
  ) => Layer.Layer<SpecialistHandler<Name>, never, Exclude<RX, Scope.Scope | AssistantChat> | ToolHandlers<R | RE>>
}

/**
 * Represents the check `toLayer` applies to the services a handler uses.
 *
 * **Details**
 *
 * Every service a handler uses must be one the run (or turn) provides, or one its build Effect
 * required, which the layer provides. A handler that uses any other service gets this type
 * error, which names those services.
 *
 * @category utility types
 * @since 0.1.0
 */
export type CheckServices<Undeclared> = [Undeclared] extends [never]
  ? unknown
  : {
      readonly "~undeclaredServices": {
        readonly error: "The handler uses services that neither the turn provides nor its build Effect requires"
        readonly services: Undeclared
      }
    }

/**
 * Extracts the tool handlers (`Toolkit.toLayer`) that a handler's loop uses.
 *
 * They are requirements of the layer, so `Layer.provide(MyToolsLive)` provides them, and a
 * missing one is a type error.
 *
 * @category utility types
 * @since 0.1.0
 */
export type ToolHandlers<R> = Extract<R, Tool.Handler<string>>

/**
 * Represents any specialist.
 *
 * @category utility types
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
 * Extracts the handlers that these specialists need.
 *
 * @category utility types
 * @since 0.1.0
 */
export type HandlerOf<S> = S extends Specialist<infer Name> ? SpecialistHandler<Name> : never

/**
 * The services a run provides to its handler, which are its chat, the chat's runner, and the
 * model.
 *
 * @category utility types
 * @since 0.1.0
 */
export type RunServices = AssistantChat | Runner | LanguageModel.LanguageModel

/**
 * Represents the options for `run.loop`.
 *
 * @category models
 * @since 0.1.0
 */
export interface LoopOptions<T extends Record<string, Tool.Any> = Record<never, never>, RS = never> {
  readonly instructions: string | Instructions.Resolved
  /** The loop's tools, as a native toolkit whose handlers come from the layer. */
  readonly toolkit?: Toolkit.Toolkit<T> | undefined
  /** Playbooks, listed as a catalog in the prompt and loaded with `load_skill` when one matches. */
  readonly skills?: ReadonlyArray<Skill<RS>> | undefined
  /** The model calls allowed per brief. Defaults to 8. */
  readonly maxSteps?: number | undefined
}

/**
 * Represents one run of a specialist on a brief, as its handler sees it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Run {
  readonly runId: RunId
  /** The chat the run works in, which is the chat of the turn that spawned it. */
  readonly chatId: ChatId
  readonly brief: Brief
  /**
   * The run's history, with the brief, what the run did so far, and the messages sent to it since
   * (follow-ups and steering). Read it before every model call, as the loop does.
   */
  readonly history: Effect.Effect<ReadonlyArray<Prompt.Message>>
  /** Runs the agent loop over the run's history, with the given instructions, tools, and skills. */
  readonly loop: <T extends Record<string, Tool.Any> = Record<never, never>, RS = never>(
    options: LoopOptions<T, RS>
  ) => Stream.Stream<
    AssistantLoop.Event,
    AiError.AiError,
    LanguageModel.LanguageModel | AssistantLoop.ToolkitServices<T> | RS
  >
}

/**
 * Represents a specialist's handler, which works on a brief and returns a stream of what the loop
 * did.
 *
 * It may return the stream from an Effect. `R` is the services the stream needs, and `RE` the
 * services the Effect needs.
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
 * Represents a specialist's handler as its layer provides it.
 *
 * `open` runs the build for a chat (once per chat activation, see `AssistantChat`) and returns
 * the handler with the layer's services already provided.
 *
 * @category models
 * @since 0.1.0
 */
export interface Built {
  readonly open: Effect.Effect<
    (run: Run) => Stream.Stream<AssistantLoop.Event, unknown, RunServices>,
    never,
    Scope.Scope | AssistantChat
  >
}

const toStream = <R, RE>(
  result:
    | Stream.Stream<AssistantLoop.Event, unknown, R>
    | Effect.Effect<Stream.Stream<AssistantLoop.Event, unknown, R>, unknown, RE>
): Stream.Stream<AssistantLoop.Event, unknown, R | RE> => (Effect.isEffect(result) ? Stream.unwrap(result) : result)

/**
 * Creates a specialist from its name and a description of when to use it.
 *
 * **Details**
 *
 * The specialist's `toLayer` provides its handler, which is usually `run.loop` with the
 * specialist's own instructions and tools. List the specialist in `Assistant.make`'s
 * `specialists`, and provide its layer to the assistant's.
 *
 * **Example** (Defining a research specialist)
 *
 * ```ts
 * import { Assistant, Specialist } from "effect-assistant"
 * import * as Layer from "effect/Layer"
 *
 * const Research = Specialist.make("research", {
 *   description: "Researches past campaigns and orders. Give it the question and any context."
 * })
 *
 * const ResearchLive = Research.toLayer((run) =>
 *   run.loop({
 *     instructions: "Answer with the findings and numbers the colleague needs, in a few lines.",
 *     toolkit: ResearchTools
 *   })
 * ).pipe(Layer.provide(ResearchToolsLive))
 *
 * export const MyAssistant = Assistant.make("my-assistant", { specialists: [Research] })
 *
 * const MyAssistantLive = MyAssistant.toLayer((turn) => turn.loop({ instructions })).pipe(
 *   Layer.provide(ResearchLive)
 * )
 * ```
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

  // The signature checks what the handler uses (`CheckServices`); the layer's services, which the
  // build required, are provided to it and to every run's stream, so what's left is the run
  // services.
  function toLayer<R = never, RE = never, E = never, RX = never>(
    build: (Handler<R, RE> | Effect.Effect<Handler<R, RE>, E, RX>) &
      CheckServices<Exclude<R | RE, RunServices | RX | Tool.Handler<string>>>
  ): Layer.Layer<SpecialistHandler<Name>, never, Exclude<RX, Scope.Scope | AssistantChat> | ToolHandlers<R | RE>>
  function toLayer(
    build: Handler<any, any> | Effect.Effect<Handler<any, any>, unknown, any>
  ): Layer.Layer<SpecialistHandler<Name>, never, any> {
    return Layer.effect(
      Handler,
      Effect.gen(function* () {
        const context = yield* Effect.context()

        return {
          // The build runs per chat activation, in the chat; here it only keeps the layer's
          // services for it.
          open: Effect.gen(function* () {
            const handler = Effect.isEffect(build) ? yield* build : build

            return (run: Run) => Stream.provideContext(toStream(handler(run)), context)
          }).pipe(Effect.provideContext(context), Effect.orDie)
        }
      })
    )
  }

  return { [TypeId]: TypeId, name, description: options.description, Handler, toLayer }
}

/**
 * Schema for the brief the assistant gives a specialist.
 *
 * Only `goal` is required.
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
  report: Schema.optional(Schema.String).annotate({
    description: "What to put in the answer, and how."
  }),
  limits: Schema.optional(Schema.String).annotate({
    description: "Hard limits for this job, like read-only or a deadline."
  })
})

/**
 * Represents the brief the assistant gives a specialist.
 *
 * @category models
 * @since 0.1.0
 */
export type Brief = typeof Brief.Type

/**
 * Represents a request to start a specialist run in the runner's chat.
 *
 * @category models
 * @since 0.1.0
 */
export interface SpawnRequest {
  /** The specialist's name. */
  readonly kind: string
  readonly brief: Brief
}

/**
 * Represents why a run request can't be carried out, written for the model.
 *
 * The request names an unknown specialist, a run that's gone, or a run that isn't running.
 *
 * @category errors
 * @since 0.1.0
 */
export class SpecialistError extends Schema.TaggedError<SpecialistError>()("SpecialistError", {
  message: Schema.String
}) {}

/**
 * Service that runs a chat's specialists and keeps finished runs warm for follow-ups.
 *
 * The engine provides it to every turn. The specialist tools use it, and a handler can too.
 *
 * @category services
 * @since 0.1.0
 */
export class Runner extends Context.Service<
  Runner,
  {
    /** Starts a run and returns its id. */
    readonly spawn: (request: SpawnRequest) => Effect.Effect<RunId, SpecialistError>
    /** Steers a running run, or continues a finished one. */
    readonly message: (runId: string, text: string) => Effect.Effect<"steered" | "continued", SpecialistError>
    /** Interrupts a running run. */
    readonly stop: (runId: string) => Effect.Effect<void, SpecialistError>
  }
>()("effect-assistant/Specialist/Runner") {}
