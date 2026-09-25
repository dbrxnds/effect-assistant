/**
 * The `AssistantTurn` module gives tools the turn they run in: which chat it
 * is.
 *
 * **Example** (A tool that acts on the current chat)
 *
 * ```ts
 * import * as Tool from "@effect-uai/core/Tool"
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import { AssistantTurn } from "effect-assistant"
 *
 * const ExportInput = Schema.Struct({ month: Schema.String })
 *
 * const startExport = Tool.make({
 *   name: "start_export",
 *   description: "Export this chat's orders to a spreadsheet.",
 *   inputSchema: ExportInput,
 *   run: Effect.fn(function*({ month }: typeof ExportInput.Type) {
 *     const turn = yield* AssistantTurn.AssistantTurn
 *     return { chatId: turn.chatId, month, status: "started" }
 *   })
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type { ChatId } from "./ChatId.ts"

/**
 * Service for the turn a tool runs in. Assistants provide it to every tool call, and
 * specialists provide it to theirs.
 *
 * @category services
 * @since 0.1.0
 */
export class AssistantTurn extends Context.Service<AssistantTurn, {
  readonly chatId: ChatId
}>()("effect-assistant/AssistantTurn") {}
