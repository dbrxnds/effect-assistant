import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { AssistantEvent, ChatId, ChatView, Compaction, InputId } from "../src/index.ts"
import * as History from "../src/internal/history.ts"

const chatId = Effect.runSync(ChatId.make())

const flyer = {
  fileId: "3f1c0a52-0000-4000-8000-000000000001",
  name: "flyer.pdf",
  mediaType: "application/pdf",
  size: 2.1 * 1024 * 1024
}

const withFile = AssistantEvent.UserMessage.make({
  id: InputId.fromKey("a"),
  text: "Print this please",
  attachments: [flyer]
})

const entries = (events: ReadonlyArray<AssistantEvent.AssistantEvent | AssistantEvent.StoredAppEvent>) =>
  events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: (i + 1) * 1000, event }))

const userTexts = (history: ReturnType<typeof History.fromEntries>) =>
  history.flatMap((message) =>
    message.role === "user" ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : []
  )

describe("attachments", () => {
  it("gives the model the text and a line per file, never content", () => {
    const history = History.fromEntries(entries([withFile]), () => undefined)

    expect(userTexts(history)).toEqual([
      `Print this please\n[attached: flyer.pdf, application/pdf, 2.1 MB, id ${flyer.fileId}]`
    ])
  })

  it("leaves a message without files as it was", () => {
    const plain = AssistantEvent.UserMessage.make({ id: InputId.fromKey("b"), text: "hi" })

    expect(userTexts(History.fromEntries(entries([plain]), () => undefined))).toEqual(["hi"])
  })

  it("survives the log's JSON form", () => {
    const encoded = Schema.encodeSync(Schema.toCodecJson(AssistantEvent.UserMessage))(withFile)
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(AssistantEvent.UserMessage))(encoded)

    expect(decoded.attachments).toEqual([flyer])
  })

  it("shows the files in the chat view", () => {
    const shown = ChatView.fromEntries(entries([withFile]), { wakes: new Set(["Update"]) })

    expect(shown.messages).toEqual([
      ChatView.UserMessage.make({
        id: withFile.id,
        text: "Print this please",
        attachments: [flyer],
        at: 1000
      })
    ])
  })

  it("keeps the id and name of a file a summary covers", () => {
    const Summary = Schema.TaggedStruct("Summary", {
      text: Schema.String,
      throughSeq: Schema.Int
    })

    const log = entries([
      withFile,
      Schema.decodeUnknownSync(AssistantEvent.StoredAppEvent)(
        Summary.make({ text: "They want a flyer printed.", throughSeq: 1 })
      )
    ])

    const [summary] = Compaction.since(Schema.is(Summary))(log)

    expect(Option.isSome(Compaction.attachedFiles(log, 1))).toBe(true)
    expect(JSON.stringify(summary)).toContain(flyer.fileId)
    expect(JSON.stringify(summary)).toContain("flyer.pdf")
  })
})
