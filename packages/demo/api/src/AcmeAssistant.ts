/**
 * Acme, the demo's assistant: its definition. The handlers are in `Acme.ts`;
 * workflows and the server use this to reach the assistant.
 *
 * @since 0.1.0
 */
import { Blocks } from "@acme/demo-shared/Blocks"
import * as Assistant from "effect-assistant/Assistant"
import { OrderPlaced } from "./OrderPlaced.ts"
import { Research } from "./Research.ts"
import { WorkflowStep } from "./WorkflowStep.ts"

/**
 * Acme: `submit`, `subscribe`, and `delete` wherever the assistant
 * engine is provided. The demo has no sign-in: every thread is everyone's.
 * It hands research to the research specialist. The API tells it when the
 * user places an order from a block (`OrderPlaced`), and the workflows report
 * their steps as `WorkflowStep`s. Both come in through `submit`, so each one
 * wakes a turn; `Acme.ts` says how the model reads them.
 *
 * @category definitions
 * @since 0.1.0
 */
export const AcmeAssistant = Assistant.make("acme", {
  blocks: Blocks,
  specialists: [Research],
  events: [OrderPlaced, WorkflowStep]
})
