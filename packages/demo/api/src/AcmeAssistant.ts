/**
 * Acme, the demo's assistant: its definition. The handlers are in `Acme.ts`;
 * workflows and the server use this to reach the assistant.
 *
 * @since 0.1.0
 */
import { Blocks } from "@acme/demo-shared/Blocks"
import * as Assistant from "effect-assistant/Assistant"
import { Research } from "./Research.ts"

/**
 * Acme: `submit` and `subscribe` wherever the assistant engine is
 * provided. The demo has no sign-in: every thread is everyone's. It hands
 * research to the research specialist.
 *
 * @category definitions
 * @since 0.1.0
 */
export const AcmeAssistant = Assistant.make("acme", {
  blocks: Blocks,
  specialists: [Research]
})
