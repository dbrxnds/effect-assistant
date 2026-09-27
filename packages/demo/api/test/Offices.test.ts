import * as Locations from "@acme/demo-shared/Locations"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as LiveOrders from "../src/LiveOrders.ts"
import * as Tools from "../src/Tools.ts"

/** The offices tool's result for these params. */
const offices = (params: { readonly name?: string }) =>
  Effect.gen(function* () {
    const toolkit = yield* Tools.LookupTools
    const results = yield* toolkit.handle("offices", params)

    return Option.flatMap(yield* Stream.runLast(results), (result) =>
      Schema.decodeUnknownOption(Tools.Offices.successSchema)(result.encodedResult)
    )
  }).pipe(Effect.provide(Tools.layerLookups.pipe(Layer.provide(LiveOrders.layerMemory))))

describe("offices tool", () => {
  it.effect("returns Amsterdam with address and contact", () =>
    Effect.gen(function* () {
      const result = Option.getOrThrow(yield* offices({ name: "Amsterdam" }))

      expect(result).toHaveLength(1)
      expect(result[0]?.name).toBe("Acme Amsterdam")
      expect(result[0]?.address.addressLine1).toBe("Herengracht 420")
      expect(result[0]?.contact.email).toBe("amsterdam@acme.example")
    })
  )

  it.effect("lists every demo office when name is omitted", () =>
    Effect.gen(function* () {
      const result = Option.getOrThrow(yield* offices({}))

      expect(result).toHaveLength(Locations.all.length)
    })
  )
})
