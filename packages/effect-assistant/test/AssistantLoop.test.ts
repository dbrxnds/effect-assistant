import { describe, expect, it } from "@effect/vitest"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Assistant, AssistantLoop } from "../src/index.ts"
import { collectUntil, newChat, runMemory, say, toolsRun, turnsDone } from "./utils/fixtures.ts"
import * as Scripted from "./utils/scripted.ts"

const Lookup = Tool.make("lookup", {
  description: "Looks a thing up.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String
})

const LookupTools = Toolkit.make(Lookup)

const LookupToolsLive = LookupTools.toLayer({ lookup: ({ id }) => Effect.succeed(`found ${id}`) })

const Own = Assistant.make("own-loop-tools")

describe("AssistantLoop.run in a turn", () => {
  it.live("runs the app's native toolkit, with the assistant's own tools next to it", () =>
    Effect.gen(function* () {
      const model = Scripted.layer((request) =>
        Scripted.hasCalled(request, "lookup") ? Scripted.reply("Found it.") : [Scripted.call("lookup", { id: "7" })]
      )

      // The handlers come from the layer; leaving out LookupToolsLive is a type error.
      const handlers = Own.toLayer((turn) =>
        AssistantLoop.run({
          instructions: turn.instructions("Be brief."),
          toolkit: LookupTools,
          history: turn.history()
        }).pipe(Stream.concat(turn.replyIfOwed({ instructions: "Be brief." })))
      ).pipe(Layer.provide(LookupToolsLive))

      const entries = yield* Effect.gen(function* () {
        const chat = yield* newChat
        yield* Own.submit(chat, say("Look up 7."))

        return yield* collectUntil(Own, chat, (es) => turnsDone(es) >= 1, "10 seconds")
      }).pipe(Effect.provide(runMemory(handlers, model)))

      // The app's tool ran, and send_user_message, the assistant's own, too.
      expect(toolsRun(entries)).toEqual(["lookup", "send_user_message"])
    })
  )
})
