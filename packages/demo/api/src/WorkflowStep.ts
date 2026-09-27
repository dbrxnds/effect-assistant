/**
 * What the demo's workflows report to the chat: a step of a run, as one of
 * Acme's own events. It wakes a turn, and the model reads it as a
 * `<workflow>` update the user hasn't seen.
 *
 * @since 0.1.0
 */
import * as AppEvent from "effect-assistant/AppEvent"
import * as InputId from "effect-assistant/InputId"
import * as RunId from "effect-assistant/RunId"
import * as Schema from "effect/Schema"

/**
 * One step of a workflow's run: which workflow, which run, its status now,
 * and what goes with it (a reference, a tracking number, results).
 *
 * @category models
 * @since 0.1.0
 */
export class WorkflowStep extends Schema.TaggedClass<WorkflowStep>()("WorkflowStep", {
  /** Per run and status, so a step that runs again reports once. */
  id: InputId.InputId,
  workflow: Schema.Literals(["CreateCampaign", "PrintOrder"]),
  runId: RunId.RunId,
  status: Schema.String,
  details: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]))
}) {}

const detailsJson = Schema.encodeSync(Schema.fromJsonString(WorkflowStep.fields.details))

/**
 * How the model reads a step.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (step: WorkflowStep): string =>
  `<workflow name="${step.workflow}" run="${step.runId}" status="${step.status}">\nAn update from a run you started. The user hasn't seen it: tell them if it matters to them.\n${detailsJson(step.details)}\n</workflow>`

/**
 * The step, registered with Acme: it wakes a turn.
 *
 * @category events
 * @since 0.1.0
 */
export const event = AppEvent.make(WorkflowStep, { wakes: true, render })
