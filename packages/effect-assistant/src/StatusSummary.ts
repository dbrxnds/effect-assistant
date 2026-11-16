/**
 * This module provides the status a turn shows when nothing else says what it is doing: when the
 * line stays empty for a while, or a call's status still shows after that call ended, a model reads
 * the turn so far and writes a few words about it, like "Comparing last year's budgets".
 *
 * Provide {@link layer} next to the assistant's `toLayer`, with a small, fast model of its own.
 * Without it, a turn shows only the statuses its tool calls write (see `ToolStatus`). The summary
 * is a `ChatSignal.Status` like any other: it is never stored and the turn's model never reads it.
 * It never replaces the status of a described call that still runs, never shows while the model
 * writes to the user, and never after the turn's message unless the model starts new work. A
 * summary that says what the line says already isn't sent.
 *
 * @since 0.13.0
 */
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Prompt from "effect/ai/Prompt"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

/**
 * The instructions the summary's model gets by default.
 *
 * @category constants
 * @since 0.13.0
 */
export const defaultInstructions =
  'You write the status line a chat shows while an assistant works for its user. Read what the assistant did so far in this turn and say what it is doing now, in 3 to 5 plain words, in the language the user writes in, like "Comparing last year\'s budgets". No tool names, ids, code, quotes or final period. Answer with the status only.'

/**
 * Represents the options accepted by {@link layer}.
 *
 * @category models
 * @since 0.13.0
 */
export interface Options {
  /** How long the line may stay empty before a summary fills it. Defaults to 2 seconds. */
  readonly after?: Duration.Input | undefined
  /** How long a line may stay unchanged before a summary refreshes it. Defaults to 5 seconds. */
  readonly staleAfter?: Duration.Input | undefined
  /** The summary model's instructions. Defaults to {@link defaultInstructions}. */
  readonly instructions?: string | undefined
}

/**
 * Service that writes a turn's status from what the turn did so far.
 *
 * @category services
 * @since 0.13.0
 */
export class StatusSummary extends Context.Service<
  StatusSummary,
  {
    readonly after: Duration.Duration
    readonly staleAfter: Duration.Duration
    /**
     * Returns the status for a turn, from its transcript: the user's input and what the assistant
     * did since. `None` when the model wrote nothing usable or its call failed.
     */
    readonly summarize: (transcript: string) => Effect.Effect<Option.Option<string>>
  }
>()("effect-assistant/StatusSummary") {}

const MAX_LENGTH = 60

const clean = (text: string): Option.Option<string> => {
  const line = (text.trim().split("\n")[0] ?? "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[.…]+$/, "")
    .trim()

  return line === "" || line.length > MAX_LENGTH ? Option.none() : Option.some(line)
}

/**
 * Creates the summary on the model it is given: provide a small, fast one.
 *
 * **Example** (A cheap model for statuses)
 *
 * ```ts
 * import { StatusSummary } from "effect-assistant"
 * import * as Layer from "effect/Layer"
 *
 * declare const MyAssistantLive: Layer.Layer<never>
 * declare const FastModel: Layer.Layer<import("effect/ai/LanguageModel").LanguageModel>
 *
 * export const Live = MyAssistantLive.pipe(
 *   Layer.provide(StatusSummary.layer({ after: "2 seconds" }).pipe(Layer.provide(FastModel)))
 * )
 * ```
 *
 * @category layers
 * @since 0.13.0
 */
export const layer = (options?: Options): Layer.Layer<StatusSummary, never, LanguageModel.LanguageModel> =>
  Layer.effect(
    StatusSummary,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      const instructions = options?.instructions ?? defaultInstructions

      const summarize = Effect.fn("StatusSummary.summarize")(function* (transcript: string) {
        const response = yield* model.generateText({
          prompt: Prompt.fromMessages([
            Prompt.systemMessage({ content: instructions }),
            Prompt.userMessage({ content: [Prompt.textPart({ text: transcript })] })
          ])
        })

        return clean(response.text)
      })

      return StatusSummary.of({
        after: Duration.fromInputUnsafe(options?.after ?? "2 seconds"),
        staleAfter: Duration.fromInputUnsafe(options?.staleAfter ?? "5 seconds"),
        summarize: (transcript) =>
          summarize(transcript).pipe(
            Effect.catchCause((cause) =>
              Effect.as(Effect.logDebug("assistant status summary failed", cause), Option.none())
            )
          )
      })
    })
  )
