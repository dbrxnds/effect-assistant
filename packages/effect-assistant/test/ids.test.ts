import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"
import { ChatId, InputId, RunId } from "../src/index.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const prefixed = (prefix: string) => new RegExp(`^${prefix}:${uuid.source.slice(1)}`)

/** Compile-time proof that the id types are the prefixed template, not a plain string. */
type TemplateBrand<Id, Prefix extends string> = Id extends `${Prefix}${string}` ? true : never

const _chatTemplate: TemplateBrand<ChatId.ChatId, "chat:"> = true

const _runTemplate: TemplateBrand<RunId.RunId, "run:"> = true

const _chatEncoded: TemplateBrand<(typeof ChatId.ChatId)["Encoded"], "chat:"> = true

const _notPlainString: `chat:${string}` extends ChatId.ChatId ? never : true = true

void [_chatTemplate, _runTemplate, _chatEncoded, _notPlainString]

const decodes = (schema: typeof ChatId.ChatId | typeof RunId.RunId, input: string) =>
  Option.isSome(Schema.decodeUnknownOption(schema)(input))

describe("ids", () => {
  it.effect("mints prefixed UUIDs, from Random", () =>
    Effect.gen(function* () {
      expect(yield* ChatId.make).toMatch(prefixed("chat"))
      expect(yield* RunId.make).toMatch(prefixed("run"))
      expect(yield* InputId.make).toMatch(uuid)
      // Seeded, the same ids every time.
      const seeded = () => ChatId.make.pipe(Random.withSeed(1))
      expect(yield* seeded()).toBe(yield* seeded())
    })
  )

  it("makes the same run id for the same key, and takes a given input id", () => {
    expect(RunId.fromKey("tool-call:toolu_1")).toBe(RunId.fromKey("tool-call:toolu_1"))
    expect(RunId.fromKey("tool-call:toolu_1")).not.toBe(RunId.fromKey("tool-call:toolu_2"))
    expect(RunId.fromKey("tool-call:toolu_1")).toMatch(prefixed("run"))
    expect(InputId.fromKey("run:1:shipped")).toBe("run:1:shipped")
  })

  it.effect("rejects ids outside the prefixed UUID", () =>
    Effect.gen(function* () {
      expect(decodes(ChatId.ChatId, "default")).toBe(false)
      expect(decodes(ChatId.ChatId, "thread-1")).toBe(false)
      expect(decodes(RunId.RunId, "run-1")).toBe(false)
      expect(decodes(ChatId.ChatId, "chat:short")).toBe(false)
      expect(decodes(ChatId.ChatId, `chat:${"!".repeat(36)}`)).toBe(false)
      expect(decodes(ChatId.ChatId, `run:${yield* InputId.make}`)).toBe(false)
      expect(decodes(ChatId.ChatId, yield* ChatId.make)).toBe(true)
    })
  )
})
