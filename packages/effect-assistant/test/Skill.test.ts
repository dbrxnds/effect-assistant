import { describe, expect, it } from "@effect/vitest"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { type AssistantEvent, Skill, ToolFailure } from "../src/index.ts"
import {
  collectUntil,
  failures,
  newChat,
  runMemory,
  say,
  TestAssistant,
  text,
  traceEntries,
  turnsDone
} from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const instructions = "You help a small team."

const onboarding = Skill.make("Onboarding", {
  description: "Use when someone new is joining the team.",
  instructions: "Book a buddy lunch on day one."
})

/** Where the offboarding playbook lives: a service its instructions read when it's loaded. */
class Playbooks extends Context.Service<Playbooks, { readonly offboarding: string }>()("test/Playbooks") {}

const offboarding = Skill.make("Offboarding", {
  description: "Use when someone is leaving.",
  instructions: Playbooks.use((playbooks) => Effect.succeed(playbooks.offboarding))
})

const PlaybooksLive = Layer.succeed(Playbooks, { offboarding: "Collect the laptop." })

const Parking = Tool.make("parking_availability", {
  description: "Free parking spots at an office.",
  parameters: Schema.Struct({ office: Schema.String }),
  success: Schema.Int
})

const OfficeTools = Toolkit.make(Parking)

const OfficeToolsLive = OfficeTools.toLayer({ parking_availability: () => Effect.succeed(37) })

/** Loads the skill the test asks for, then replies with what it read. */
const loading = (name: string) =>
  Scripted.make((request) => {
    const loaded = Scripted.lastResult(request, "load_skill")

    return Option.isSome(loaded) ? Scripted.reply(loaded.value) : [Scripted.call("load_skill", { name })]
  })

const loadResults = (entries: ReadonlyArray<AssistantEvent.Entry>) =>
  entries.flatMap(({ event }) =>
    Predicate.isTagged(event, "ToolResult") && event.tool === "load_skill" ? [event] : []
  )

describe("Skill.toolkit", () => {
  it.live("offers load_skill, whose description is the catalog, merged with the loop's own tools", () =>
    Effect.gen(function* () {
      const model = yield* loading("Offboarding")
      const Skills = Skill.toolkit([onboarding, offboarding])

      const handlers = TestAssistant.toLayer((turn) =>
        turn.loop({ instructions, toolkit: Toolkit.merge(OfficeTools, Skills) })
      ).pipe(Layer.provide([OfficeToolsLive, Skills.layer.pipe(Layer.provide(PlaybooksLive))]))

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("Sam leaves Friday."))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(runMemory(handlers, model.layer)))

      const [request] = yield* model.requests

      expect(failures(entries), traceEntries(entries)).toEqual([])
      expect(request?.tools).toEqual(expect.arrayContaining(["parking_availability", "load_skill"]))
      expect(request?.descriptions.get("load_skill")).toContain(
        "- Onboarding: Use when someone new is joining the team.\n- Offboarding: Use when someone is leaving."
      )
      // The catalog is the tool's, not the prompt's.
      expect(request?.system).not.toContain("Onboarding")
      // The instructions resolved with the service the layer was given.
      expect(text(entries)).toContain("collect the laptop")
    })
  )

  it.live("answers a name it doesn't have with a failure the model reads, naming the skills there are", () =>
    Effect.gen(function* () {
      const model = yield* loading("Invoicing")
      const Skills = Skill.toolkit([onboarding])

      const handlers = TestAssistant.toLayer((turn) => turn.loop({ instructions, toolkit: Skills })).pipe(
        Layer.provide(Skills.layer)
      )

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("Where is invoice 12?"))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(runMemory(handlers, model.layer)))

      const [result] = loadResults(entries)
      const failure = Schema.decodeUnknownOption(ToolFailure.ToolFailure)(result?.result)

      expect(result?.outcome).toBe("failure")
      expect(Option.map(failure, ({ message }) => message)).toEqual(
        Option.some("No skill named Invoicing. The skills are: Onboarding.")
      )
    })
  )

  it.live("is built per turn from the skills a user may use, with its layer provided to the loop", () =>
    Effect.gen(function* () {
      const model = yield* loading("Offboarding")

      // A viewer may onboard but not offboard.
      const allowed = (skill: Skill.Skill<Playbooks>) => skill.name !== "Offboarding"

      const handlers = TestAssistant.toLayer(
        Effect.gen(function* () {
          const playbooks = yield* Playbooks

          return (turn) => {
            const Skills = Skill.toolkit([onboarding, offboarding].filter(allowed))

            return turn
              .loop({ instructions, toolkit: Skills })
              .pipe(Stream.provide(Skills.layer), Stream.provideService(Playbooks, playbooks))
          }
        })
      ).pipe(Layer.provide(PlaybooksLive))

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* (yield* TestAssistant).submit(chat, say("Sam leaves Friday."))

        return yield* collectUntil(TestAssistant, chat, (es) => turnsDone(es) >= 1)
      }).pipe(Effect.provide(runMemory(handlers, model.layer)))

      const [request] = yield* model.requests

      expect(request?.descriptions.get("load_skill")).not.toContain("Offboarding")
      expect(loadResults(entries).map((result) => result.outcome)).toEqual(["failure"])
      expect(text(entries)).not.toContain("laptop")
    })
  )
})
