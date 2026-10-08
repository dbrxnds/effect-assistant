/**
 * Evals: run an assistant on a set of cases, score what comes out, and report
 * how often it does what it should.
 *
 * A model doesn't answer the same way twice, so an eval runs every case
 * several times (`trials`) and reports rates, not a verdict: a case that
 * passes two runs in three is a finding, not a flake.
 *
 * ```ts
 * const orders = Eval.make({
 *   name: "orders",
 *   cases: [{ id: "reorder", input: "Reorder that one product from last month" }],
 *   task: (message) => play(message),
 *   scorers: [Eval.scorer("placed", ({ output }) =>
 *     Effect.succeed([Eval.pass("placed", output.ordered)]))],
 * })
 *
 * const report = yield* Eval.run(orders, { trials: 3 })
 * console.log(Eval.format(report))
 * ```
 */
import { Cause, Effect, Exit, Predicate, Record, Schema, type Duration } from "effect"
import { type AiError, LanguageModel } from "effect/ai"

/** One thing to try: what the assistant is given, and tags to filter and group by. */
export interface Case<Input> {
  readonly id: string
  readonly input: Input
  /** What the case is about: "orders", "safety". */
  readonly tags?: ReadonlyArray<string> | undefined
}

/** A grade, from 0 (wrong) to 1 (right). */
export interface Score {
  readonly name: string
  readonly value: number
  readonly comment?: string | undefined
}

/** A pass or fail as a score; `comment` says what went wrong, so a pass has none. */
export const pass = (name: string, ok: boolean, comment?: string): Score => ({
  name,
  value: ok ? 1 : 0,
  comment: ok ? undefined : comment
})

/** What a scorer sees: the case and what the task made of it. */
export interface Run<Input, Output> {
  readonly case: Case<Input>
  readonly output: Output
}

/** Grades what the task made of a case. A scorer that fails is reported as an error, not as a 0. */
export interface Scorer<Input, Output, E = never, R = never> {
  readonly name: string
  readonly score: (run: Run<Input, Output>) => Effect.Effect<ReadonlyArray<Score>, E, R>
}

export const scorer = <Input, Output, E = never, R = never>(
  name: string,
  score: Scorer<Input, Output, E, R>["score"]
): Scorer<Input, Output, E, R> => ({ name, score })

export interface Evaluation<Input, Output, E, R, SE, SR> {
  readonly name: string
  readonly cases: ReadonlyArray<Case<Input>>
  /** Does what the case says, and returns what the scorers need to see. */
  readonly task: (input: Input) => Effect.Effect<Output, E, R>
  readonly scorers: ReadonlyArray<Scorer<Input, Output, SE, SR>>
  /** Numbers to track besides the scores: how long it took, what it cost. */
  readonly metrics?: (output: Output) => Readonly<Record<string, number>>
}

export const make = <Input, Output, E, R, SE, SR>(
  evaluation: Evaluation<Input, Output, E, R, SE, SR>
): Evaluation<Input, Output, E, R, SE, SR> => evaluation

// -----------------------------------------------------------------------------
// running
// -----------------------------------------------------------------------------

/** One trial of one case. */
export interface Result<Input, Output> {
  readonly case: Case<Input>
  /** From 1. */
  readonly trial: number
  /** What the task made of it, unless it failed. */
  readonly output: Output | undefined
  readonly scores: ReadonlyArray<Score>
  readonly metrics: Readonly<Record<string, number>>
  /** The task or a scorer failed: why. A task that failed has no scores. */
  readonly errors: ReadonlyArray<string>
  readonly duration: Duration.Duration
  /** The trace of this trial, for linking it to wherever the traces go. */
  readonly traceId: string | undefined
}

export interface Report<Input, Output> {
  readonly name: string
  readonly trials: number
  readonly results: ReadonlyArray<Result<Input, Output>>
}

export interface RunOptions<Input, Output> {
  /** How many times every case runs. Default 1. */
  readonly trials?: number | undefined
  /** How many cases run at once. Default 4. */
  readonly concurrency?: number | undefined
  /** Only the cases with these ids or tags. */
  readonly only?: ReadonlyArray<string> | undefined
  /** Called as each trial finishes, for progress. */
  readonly onResult?: ((result: Result<Input, Output>) => Effect.Effect<void>) | undefined
}

const failed = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)

  return Predicate.isError(error) ? error.message : String(error)
}

/** Runs every case `trials` times, each in a span of its own, and scores them. */
export const run = Effect.fn("Eval.run")(function* <Input, Output, E, R, SE, SR>(
  evaluation: Evaluation<Input, Output, E, R, SE, SR>,
  options?: RunOptions<Input, Output>
) {
  const trials = options?.trials ?? 1
  const only = options?.only ?? []

  const selected = evaluation.cases.filter(
    (item) => only.length === 0 || only.includes(item.id) || (item.tags ?? []).some((tag) => only.includes(tag))
  )

  const attempts = selected.flatMap((item) =>
    Array.from({ length: trials }, (_, index) => ({ item, trial: index + 1 }))
  )

  const attempt = Effect.fn("Eval.trial")(function* (item: Case<Input>, trial: number) {
    const span = yield* Effect.currentSpan
    yield* Effect.annotateCurrentSpan({ "eval.name": evaluation.name, "eval.case": item.id })
    yield* Effect.annotateCurrentSpan("eval.trial", trial)

    const [duration, made] = yield* Effect.timed(Effect.exit(evaluation.task(item.input)))

    // An interrupt is the run being stopped, not a case failing.
    if (Exit.isFailure(made) && Cause.hasInterruptsOnly(made.cause)) return yield* Effect.failCause(made.cause)

    const base = { case: item, trial, duration, traceId: span.traceId }

    if (Exit.isFailure(made)) {
      return {
        ...base,
        output: undefined,
        scores: [],
        metrics: {},
        errors: [`task: ${failed(made.cause)}`]
      }
    }

    const output = made.value

    const graded = yield* Effect.forEach(evaluation.scorers, (each) =>
      each.score({ case: item, output }).pipe(
        Effect.exit,
        Effect.map((exit) =>
          Exit.isSuccess(exit)
            ? { scores: exit.value, error: undefined }
            : { scores: [], error: `scorer ${each.name}: ${failed(exit.cause)}` }
        )
      )
    )

    const result: Result<Input, Output> = {
      ...base,
      output,
      scores: graded.flatMap(({ scores }) => scores),
      metrics: evaluation.metrics?.(output) ?? {},
      errors: graded.flatMap(({ error }) => (error === undefined ? [] : [error]))
    }

    yield* annotateScores(result.scores)

    return result
  })

  const results = yield* Effect.forEach(
    attempts,
    ({ item, trial }) =>
      attempt(item, trial).pipe(
        Effect.withSpan(`eval ${evaluation.name}/${item.id}`, { root: true }),
        Effect.tap((result) => options?.onResult?.(result) ?? Effect.void)
      ),
    { concurrency: options?.concurrency ?? 4 }
  )

  const report: Report<Input, Output> = { name: evaluation.name, trials, results }

  return report
})

const annotateScores = (scores: ReadonlyArray<Score>) =>
  Effect.annotateCurrentSpan(Object.fromEntries(scores.map((score) => [`eval.score.${score.name}`, score.value])))

// -----------------------------------------------------------------------------
// reading a report
// -----------------------------------------------------------------------------

/** Mean of the numbers; 0 for none. */
const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

/** The mean of each score across the trials that have it. */
const means = (results: ReadonlyArray<{ readonly scores: ReadonlyArray<Score> }>) =>
  Record.map(
    Record.fromIterableWith(
      results.flatMap(({ scores }) => scores),
      (score) => [score.name, score.name] as const
    ),
    (name) => mean(results.flatMap(({ scores }) => scores.filter((s) => s.name === name).map((s) => s.value)))
  )

export interface CaseSummary {
  readonly id: string
  readonly trials: number
  readonly errors: number
  readonly scores: Readonly<Record<string, number>>
}

export interface Summary {
  readonly trials: number
  readonly errors: number
  /** Each score's mean over every trial. */
  readonly scores: Readonly<Record<string, number>>
  readonly metrics: Readonly<Record<string, number>>
  readonly cases: ReadonlyArray<CaseSummary>
}

export const summarize = <Input, Output>(report: Report<Input, Output>): Summary => {
  const ids = [...new Set(report.results.map(({ case: item }) => item.id))]

  return {
    trials: report.results.length,
    errors: report.results.filter(({ errors }) => errors.length > 0).length,
    scores: means(report.results),
    metrics: Record.map(
      Record.fromIterableWith(
        report.results.flatMap(({ metrics }) => Object.keys(metrics)),
        (name) => [name, name] as const
      ),
      (name) => mean(report.results.flatMap(({ metrics }) => metrics[name] ?? []))
    ),
    cases: ids.map((id) => {
      const trials = report.results.filter(({ case: item }) => item.id === id)

      return {
        id,
        trials: trials.length,
        errors: trials.filter(({ errors }) => errors.length > 0).length,
        scores: means(trials)
      }
    })
  }
}

/** Whether every score's mean is at least `minimum` (default 1) and nothing failed to run. */
export const passed = <Input, Output>(
  report: Report<Input, Output>,
  options?: { readonly minimum?: number }
): boolean => {
  const summary = summarize(report)

  return summary.errors === 0 && Object.values(summary.scores).every((value) => value >= (options?.minimum ?? 1))
}

const percent = (value: number) => `${Math.round(value * 100)}%`

/** A table: a row per case with each score's mean, then the means over all of them. */
export const format = <Input, Output>(report: Report<Input, Output>): string => {
  const summary = summarize(report)
  const names = Object.keys(summary.scores)
  const width = Math.max(4, ...summary.cases.map(({ id }) => id.length))

  const row = (label: string, cells: ReadonlyArray<string>) =>
    `${label.padEnd(width)}  ${cells.map((cell, index) => cell.padStart(Math.max(5, names[index]?.length ?? 5))).join("  ")}`

  const lines = [
    `${report.name}: ${summary.cases.length} cases, ${summary.trials} trials, ${summary.errors} with errors`,
    row("case", names),
    ...summary.cases.map((item) =>
      row(
        item.errors > 0 ? `${item.id} (${item.errors} errors)` : item.id,
        names.map((name) => (item.scores[name] === undefined ? "-" : percent(item.scores[name])))
      )
    ),
    row(
      "all",
      names.map((name) => percent(summary.scores[name] ?? 0))
    )
  ]

  const metrics = Object.entries(summary.metrics)

  if (metrics.length > 0)
    lines.push(`mean ${metrics.map(([name, value]) => `${name} ${Math.round(value)}`).join(", ")}`)

  const problems = report.results.flatMap(({ case: item, trial, errors }) =>
    errors.map((error) => `  ${item.id} #${trial}: ${error}`)
  )

  const flawed = report.results.flatMap(({ case: item, trial, scores }) =>
    scores
      .filter((score) => score.value < 1 && score.comment !== undefined)
      .map((score) => `  ${item.id} #${trial} ${score.name}: ${score.comment}`)
  )

  return [
    ...lines,
    ...(problems.length > 0 ? ["errors:", ...problems] : []),
    ...(flawed.length > 0 ? ["misses:", ...flawed] : [])
  ].join("\n")
}

// -----------------------------------------------------------------------------
// a model as the scorer
// -----------------------------------------------------------------------------

const Verdict = Schema.Struct({ pass: Schema.Boolean, reason: Schema.String })

const decodeVerdict = Schema.decodeUnknownEffect(Schema.fromJsonString(Verdict))

/** The first JSON object in a model's text: models wrap answers in prose and fences. */
const jsonObject = (text: string) => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")

  return start === -1 || end < start ? text : text.slice(start, end + 1)
}

/**
 * A model grades the run against a criterion: pass or fail, and why. The judge
 * sees the criterion and the `evidence` you render from the run, nothing else,
 * so put in it what the criterion is about.
 *
 * A judge is a model: check it on runs you've graded yourself before you trust
 * its rates, and don't let a model grade its own kind of output alone.
 */
export const judge = <Input, Output>(options: {
  readonly name: string
  /** What passes: "Every fact in the reply is in the tool results." */
  readonly criterion: string
  readonly evidence: (run: Run<Input, Output>) => string
}): Scorer<Input, Output, AiError.AiError | Schema.SchemaError, LanguageModel.LanguageModel> =>
  scorer(options.name, (run) =>
    Effect.gen(function* () {
      const response = yield* LanguageModel.generateText({
        prompt: [
          "You grade the work of an AI assistant against one criterion.",
          `Criterion: ${options.criterion}`,
          `Evidence:\n${options.evidence(run)}`,
          'Answer with JSON only: {"pass": true or false, "reason": "one short sentence"}.'
        ].join("\n\n")
      })

      const verdict = yield* decodeVerdict(jsonObject(response.text))

      return [{ name: options.name, value: verdict.pass ? 1 : 0, comment: verdict.reason }]
    })
  )
