import { describe, expect, it } from "@effect/vitest"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { AssistantEvent, AssistantLoop } from "../src/index.ts"

const Public = Tool.make("public_lookup", {
  description: "Open to everyone.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String
})

const Secret = Tool.make("secret_lookup", {
  description: "Not for everyone.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String
})

const tools = AssistantLoop.fromToolkit(Toolkit.make(Public, Secret), {
  public_lookup: ({ id }) => Effect.succeed(`public ${id}`),
  secret_lookup: ({ id }) => Effect.succeed(`secret ${id}`)
})

const decodeCall = Schema.decodeUnknownSync(AssistantEvent.ToolCallPart)

const call = (name: string) => decodeCall({ type: "tool-call", id: `call_${name}`, name, params: { id: "7" } })

describe("AssistantLoop.only", () => {
  const admitted = AssistantLoop.only(tools, (tool) => tool.name === "public_lookup")

  it("offers only the tools it admits", () => {
    expect(admitted.definitions.map((tool) => tool.name)).toEqual(["public_lookup"])
  })

  it.effect("runs a call to an admitted tool", () =>
    Effect.gen(function* () {
      expect(yield* admitted.run(call("public_lookup"))).toMatchObject({
        outcome: "success",
        result: "public 7"
      })
    })
  )

  it.effect("refuses a call to a tool it doesn't admit, as if it didn't exist", () =>
    Effect.gen(function* () {
      expect(yield* admitted.run(call("secret_lookup"))).toMatchObject({
        outcome: "failure",
        kind: "ToolNotFoundError"
      })
    })
  )

  it.effect("refuses to decide on or preview a call to a tool it doesn't admit", () =>
    Effect.gen(function* () {
      expect(yield* admitted.needsDecision?.(call("secret_lookup"), []) ?? Effect.succeed(false)).toBe(false)
      expect(yield* admitted.preview?.(call("secret_lookup")) ?? Effect.die("no preview")).toMatchObject({
        outcome: "failure",
        kind: "ToolNotFoundError"
      })
    })
  )
})
