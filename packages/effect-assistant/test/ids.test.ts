import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ChatId, InputId, RunId } from "../src/index.ts"

const prefixed = (prefix: string) => new RegExp(`^${prefix}:[A-Za-z0-9_-]{21}$`)

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
  it("mints prefixed nanoids", () => {
    expect(ChatId.make()).toMatch(prefixed("chat"))
    expect(RunId.make()).toMatch(prefixed("run"))
    expect(InputId.make()).toMatch(/^[A-Za-z0-9_-]{21}$/)
  })

  it("makes the same run id for the same key, and takes a given input id", () => {
    expect(RunId.fromKey("tool-call:toolu_1")).toBe(RunId.fromKey("tool-call:toolu_1"))
    expect(RunId.fromKey("tool-call:toolu_1")).not.toBe(RunId.fromKey("tool-call:toolu_2"))
    expect(RunId.fromKey("tool-call:toolu_1")).toMatch(prefixed("run"))
    expect(InputId.make("run:1:shipped")).toBe("run:1:shipped")
  })

  it("rejects ids outside the prefixed nanoid", () => {
    expect(decodes(ChatId.ChatId, "default")).toBe(false)
    expect(decodes(ChatId.ChatId, "thread-1")).toBe(false)
    expect(decodes(RunId.RunId, "run-1")).toBe(false)
    expect(decodes(ChatId.ChatId, "chat:short")).toBe(false)
    expect(decodes(ChatId.ChatId, `chat:${"!".repeat(21)}`)).toBe(false)
    expect(decodes(ChatId.ChatId, `run:${"a".repeat(21)}`)).toBe(false)
    expect(decodes(ChatId.ChatId, ChatId.make())).toBe(true)
  })
})
