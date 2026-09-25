import * as Locations from "@acme/demo-shared/Locations"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Tools from "../src/Tools.ts"

describe("offices tool", () => {
  it.effect("returns Amsterdam with address and contact", () =>
    Effect.gen(function*() {
      const result = yield* Tools.offices.run({ name: "Amsterdam" }, () => Effect.void)

      expect(result).toHaveLength(1)
      expect(result[0]?.name).toBe("Acme Amsterdam")
      expect(result[0]?.address.addressLine1).toBe("Herengracht 420")
      expect(result[0]?.contact.email).toBe("amsterdam@acme.example")
    }))

  it.effect("lists every demo office when name is omitted", () =>
    Effect.gen(function*() {
      const result = yield* Tools.offices.run({}, () => Effect.void)

      expect(result).toHaveLength(Locations.all.length)
    }))
})
