/**
 * What the demo workflows share: reporting a step to the chat, and waiting
 * between steps at demo pace.
 *
 * @since 0.1.0
 */
import * as AssistantEvent from "effect-assistant/AssistantEvent"
import type * as ChatId from "effect-assistant/ChatId"
import * as InputId from "effect-assistant/InputId"
import type * as RunId from "effect-assistant/RunId"
import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Activity from "effect/unstable/workflow/Activity"
import * as DurableClock from "effect/unstable/workflow/DurableClock"
import { AcmeAssistant } from "./AcmeAssistant.ts"

/**
 * One demo step, in seconds: `DEMO_STEP_SECONDS`, default 10. A step stands
 * for a working day or so, so a print order takes about a minute from order
 * to delivery.
 *
 * @category configuration
 * @since 0.1.0
 */
export const stepSeconds = Config.Int("DEMO_STEP_SECONDS").pipe(Config.withDefault(10))

/**
 * Waits `steps` demo steps. The wait is durable: a restart or deploy picks it
 * up where it was.
 *
 * @category combinators
 * @since 0.1.0
 */
export const wait = Effect.fn(function* (name: string, steps: number) {
  const seconds = yield* stepSeconds.pipe(Effect.orDie)

  yield* DurableClock.sleep({ name, duration: Duration.seconds(seconds * steps), inMemoryThreshold: Duration.zero })
})

/**
 * A step to report: which run, which chat, and what happened.
 *
 * @category models
 * @since 0.1.0
 */
export interface Step {
  readonly source: string
  readonly runId: RunId.RunId
  readonly chatId: ChatId.ChatId
  readonly status: string
  readonly details: Readonly<Record<string, string | number | boolean | undefined>>
}

/**
 * Tells the chat about a step, as a fact. It runs once per step, even when
 * the workflow replays, and the fact's id makes a resend harmless.
 *
 * @category combinators
 * @since 0.1.0
 */
export const report = (step: Step) =>
  Activity.make({
    name: `Report:${step.status}`,
    execute: Effect.gen(function* () {
      yield* AcmeAssistant.submit(
        step.chatId,
        AssistantEvent.Fact.make({
          id: InputId.make(`${step.runId}:${step.status}`),
          source: step.source,
          payload: { runId: step.runId, status: step.status, ...step.details }
        })
      )
    })
  })

/**
 * A reference people can quote for an order: `ACM-` plus six characters of
 * the run id.
 *
 * @category constructors
 * @since 0.1.0
 */
export const reference = (runId: RunId.RunId): string =>
  `ACM-${runId
    .slice(4)
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 6)
    .toUpperCase()}`
