/**
 * What the demo orders share: an order's reference, reporting a workflow's
 * step to the chat (a `WorkflowStep`), and waiting between steps at demo
 * pace.
 *
 * @since 0.1.0
 */
import type * as ChatId from "effect-assistant/ChatId"
import * as InputId from "effect-assistant/InputId"
import type * as RunId from "effect-assistant/RunId"
import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Activity from "effect/workflow/Activity"
import * as DurableClock from "effect/workflow/DurableClock"
import { AcmeAssistant } from "./AcmeAssistant.ts"
import { WorkflowStep } from "./WorkflowStep.ts"

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
  readonly workflow: WorkflowStep["workflow"]
  readonly runId: RunId.RunId
  readonly chatId: ChatId.ChatId
  readonly status: string
  readonly details: WorkflowStep["details"]
}

/**
 * Tells the chat about a step, as a `WorkflowStep`. It runs once per step,
 * even when the workflow replays, and the step's id makes a resend harmless.
 * A chat deleted meanwhile takes nothing: the report does nothing then.
 *
 * @category combinators
 * @since 0.1.0
 */
export const report = (step: Step) =>
  Activity.make({
    name: `Report:${step.status}`,
    execute: AcmeAssistant.use((acme) =>
      acme.submit(
        step.chatId,
        WorkflowStep.make({
          id: InputId.fromKey(`${step.runId}:${step.status}`),
          workflow: step.workflow,
          runId: step.runId,
          status: step.status,
          details: step.details
        })
      )
    ).pipe(Effect.catchTag("GetChatError", () => Effect.void))
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
