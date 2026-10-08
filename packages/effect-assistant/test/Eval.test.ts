import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Eval } from "../src/index.ts"
import * as Scripted from "./utils/scripted.ts"

interface Output {
  readonly reply: string
  readonly tokens: number
}

const cases: ReadonlyArray<Eval.Case<string>> = [
  { id: "greets", input: "hi", tags: ["chat"] },
  { id: "counts", input: "count", tags: ["maths"] }
]

const replies = new Map([
  ["hi", "hello"],
  ["count", "one two"]
])

const echo = (input: string) => Effect.succeed<Output>({ reply: replies.get(input) ?? "?", tokens: input.length * 10 })

const replied = Eval.scorer<string, Output>("replied", ({ output }) =>
  Effect.succeed([Eval.pass("replied", output.reply !== "?")])
)

const polite = Eval.scorer<string, Output>("polite", ({ case: item, output }) =>
  Effect.succeed([Eval.pass("polite", item.id === "greets" && output.reply === "hello", "rude")])
)

const evaluation = Eval.make({
  name: "chat",
  cases,
  task: echo,
  scorers: [replied, polite],
  metrics: (output) => ({ tokens: output.tokens })
})

describe("Eval", () => {
  it.effect("runs every case once per trial and averages the scores", () =>
    Effect.gen(function* () {
      const report = yield* Eval.run(evaluation, { trials: 3 })
      const summary = Eval.summarize(report)

      assert.strictEqual(report.results.length, 6)
      assert.deepStrictEqual(report.results.map(({ trial }) => trial).slice(0, 3), [1, 2, 3])
      assert.deepStrictEqual(summary.scores, { replied: 1, polite: 0.5 })
      assert.deepStrictEqual(
        summary.cases.map(({ id, scores }) => [id, scores.polite]),
        [
          ["greets", 1],
          ["counts", 0]
        ]
      )
      assert.strictEqual(summary.metrics.tokens, 35)
    })
  )

  it.effect("runs the cases with the given ids or tags", () =>
    Effect.gen(function* () {
      const byId = yield* Eval.run(evaluation, { only: ["counts"] })
      const byTag = yield* Eval.run(evaluation, { only: ["chat"] })

      assert.deepStrictEqual(
        byId.results.map(({ case: item }) => item.id),
        ["counts"]
      )
      assert.deepStrictEqual(
        byTag.results.map(({ case: item }) => item.id),
        ["greets"]
      )
    })
  )

  it.effect("reports a task that fails and goes on with the others", () =>
    Effect.gen(function* () {
      const report = yield* Eval.run(
        Eval.make({
          ...evaluation,
          task: (input: string) => (input === "hi" ? Effect.fail("the model was down") : echo(input))
        })
      )

      const [first, second] = report.results

      assert.strictEqual(first?.output, undefined)
      assert.deepStrictEqual(first?.scores, [])
      assert.isTrue(first?.errors[0]?.includes("the model was down"))
      assert.strictEqual(second?.errors.length, 0)
      assert.isFalse(Eval.passed(report, { minimum: 0 }))
    })
  )

  it.effect("reports a scorer that fails instead of scoring it 0", () =>
    Effect.gen(function* () {
      const broken = Eval.scorer<string, Output, string>("broken", () => Effect.fail("no verdict"))
      const report = yield* Eval.run(Eval.make({ ...evaluation, scorers: [replied, broken] }))
      const [first] = report.results

      assert.deepStrictEqual(
        first?.scores.map(({ name }) => name),
        ["replied"]
      )
      assert.deepStrictEqual(first?.errors, ["scorer broken: no verdict"])
    })
  )

  it.effect("passes when every score reaches the minimum", () =>
    Effect.gen(function* () {
      const report = yield* Eval.run(evaluation)

      assert.isFalse(Eval.passed(report))
      assert.isFalse(Eval.passed(report, { minimum: 0.9 }))
      assert.isTrue(Eval.passed(report, { minimum: 0.5 }))
    })
  )

  it.effect("gives every trial a trace of its own", () =>
    Effect.gen(function* () {
      const report = yield* Eval.run(evaluation, { trials: 2 })
      const ids = report.results.map(({ traceId }) => traceId)

      assert.isTrue(ids.every((id) => id !== undefined))
      assert.strictEqual(new Set(ids).size, ids.length)
    })
  )

  it.effect("tells the table what missed and why", () =>
    Effect.gen(function* () {
      const text = Eval.format(yield* Eval.run(evaluation))

      assert.include(text, "chat: 2 cases, 2 trials, 0 with errors")
      assert.include(text, "counts")
      assert.include(text, "counts #1 polite: rude")
    })
  )

  describe("judge", () => {
    const grounded = Eval.judge<string, Output>({
      name: "grounded",
      criterion: "The reply says only what the input allows.",
      evidence: ({ case: item, output }) => `input: ${item.input}\nreply: ${output.reply}`
    })

    const verdictFor = (text: string) => Scripted.layer(() => [Scripted.text(text)])

    it.effect("scores the model's verdict, with its reason", () =>
      Effect.gen(function* () {
        const report = yield* Eval.run(Eval.make({ ...evaluation, scorers: [grounded] }), {
          only: ["greets"]
        })

        assert.deepStrictEqual(report.results[0]?.scores, [
          { name: "grounded", value: 0, comment: "It made something up." }
        ])
      }).pipe(Effect.provide(verdictFor('Sure:\n```json\n{"pass": false, "reason": "It made something up."}\n```')))
    )

    it.effect("shows the judge the criterion and the evidence", () =>
      Effect.gen(function* () {
        const model = yield* Scripted.make(() => [Scripted.text('{"pass": true, "reason": "ok"}')])
        yield* Eval.run(Eval.make({ ...evaluation, scorers: [grounded] }), {
          only: ["greets"]
        }).pipe(Effect.provide(model.layer))
        const [request] = yield* model.requests
        const prompt = Scripted.lastInput(request!)

        assert.include(prompt, "The reply says only what the input allows.")
        assert.include(prompt, "reply: hello")
      })
    )

    it.effect("reports a verdict it can't read", () =>
      Effect.gen(function* () {
        const report = yield* Eval.run(Eval.make({ ...evaluation, scorers: [grounded] }), {
          only: ["greets"]
        })

        assert.deepStrictEqual(report.results[0]?.scores, [])
        assert.isTrue(report.results[0]?.errors[0]?.startsWith("scorer grounded:"))
      }).pipe(Effect.provide(verdictFor("I think it is fine.")))
    )
  })
})
