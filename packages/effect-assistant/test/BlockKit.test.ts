import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { AssistantEvent, Block, BlockKit, ChatId, ChatView, Decision, InputId } from "../src/index.ts"
import { say } from "./utils/fixtures.ts"

const Choose = Block.make("choose_one", {
  description: "Let the user pick one option.",
  props: Schema.Struct({ options: Schema.Array(Schema.String) }),
  answer: Schema.Struct({ choice: Schema.String })
})

const PickDate = Block.make("pick_date", {
  description: "Let the user pick a date.",
  props: Schema.Struct({ label: Schema.String }),
  answer: Schema.Struct({ date: Schema.Date })
})

const kit = BlockKit.make([Choose, PickDate])

const message = (id: string, block?: AssistantEvent.MessageBlock) =>
  block === undefined
    ? AssistantEvent.AssistantMessage.make({ id, text: "Pick one" })
    : AssistantEvent.AssistantMessage.make({ id, text: "Pick one", block })

/** A message as a client's view has it, after these events. */
const viewed = (id: string, events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  ChatView.fromEntries(
    events.map((event, i) =>
      AssistantEvent.Entry.make({ chatId: Effect.runSync(ChatId.make), seq: i + 1, at: 0, event })
    )
  ).messages.find(
    (shown): shown is ChatView.AssistantMessage => shown.id === id && Predicate.isTagged(shown, "AssistantMessage")
  )!

const choice = (options: ReadonlyArray<string>) =>
  AssistantEvent.MessageBlock.make({ kind: "choose_one", props: { options } })

const answer = (messageId: string, value: string) =>
  AssistantEvent.BlockAnswer.make({
    id: InputId.fromKey(`${messageId}:answer`),
    messageId,
    kind: "choose_one",
    value: { choice: value }
  })

describe("BlockKit.toClient", () => {
  const render = BlockKit.toClient(kit, {
    choose_one: ({ text, props, answer, respond }) => {
      if (answer === undefined) respond({ choice: props.options[1]! })

      return answer === undefined ? `${text}: ${props.options.join("/")}` : `picked ${answer.choice}`
    },
    pick_date: ({ props, respond }) => {
      respond({ date: new Date("2026-10-01T00:00:00Z") })

      return `date: ${props.label}`
    }
  })

  it("renders a block and sends its answer", () => {
    const sent: Array<AssistantEvent.BlockAnswer> = []

    const out = render(viewed("m1", [message("m1", choice(["red", "blue"]))]), {
      respond: (a) => sent.push(a)
    })

    expect(out).toBe("Pick one: red/blue")
    expect(sent[0]).toBeInstanceOf(AssistantEvent.BlockAnswer)
    expect(sent[0]).toMatchObject({
      messageId: "m1",
      kind: "choose_one",
      value: { choice: "blue" }
    })
  })

  it("passes the answer once there is one", () => {
    const out = render(viewed("m1", [message("m1", choice(["red", "blue"])), answer("m1", "red")]), {
      respond: () => {}
    })

    expect(out).toBe("picked red")
  })

  it("returns undefined for no block and unknown kinds", () => {
    const respond = () => undefined

    const shown = (id: string, block?: AssistantEvent.MessageBlock) =>
      render(viewed(id, [message(id, block)]), { respond })

    expect(shown("m3")).toBeUndefined()
    expect(shown("m4", AssistantEvent.MessageBlock.make({ kind: "mystery", props: {} }))).toBeUndefined()
  })
})

describe("BlockKit.blockStates", () => {
  it("closes a block on its answer, or when the assistant says it was answered in words", () => {
    const chatId = Effect.runSync(ChatId.make)

    const events = [
      message("m1", choice(["red", "blue"])),
      answer("m1", "red"),
      answer("m1", "blue"), // a second answer changes nothing
      message("m2", choice(["a", "b"])),
      say("neither, make it green"),
      AssistantEvent.AssistantMessage.make({ id: "m3", text: "Green it is.", closes: ["m2"] }),
      message("m4", choice(["x", "y"])),
      say("what time is it?"), // about something else: m4 stays open
      message("m5", choice(["p", "q"])),
      answer("m5", "p"), // another block's answer leaves m4 open too
      message("m6") // a later assistant message doesn't close it
    ]

    const states = BlockKit.blockStates(
      events.map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: 0, event }))
    )

    expect(states.get("m1")).toMatchObject({ open: false, answer: { value: { choice: "red" } } })
    expect(states.get("m2")).toEqual({ open: false, answer: undefined })
    expect(states.has("m3")).toBe(false)
    expect(states.get("m4")).toEqual({ open: true, answer: undefined })
    expect(states.get("m5")).toMatchObject({ open: false, answer: { value: { choice: "p" } } })
    expect(states.has("m6")).toBe(false)
  })

  it("finds the blocks the user moved on from, and closes them with BlocksClosed", () => {
    const chatId = Effect.runSync(ChatId.make)

    const events = [
      message("m1", choice(["red", "blue"])),
      say("hmm"),
      say("let me think"),
      message("m2", choice(["a", "b"])),
      say("blue") // answered in words, and the assistant didn't close it
    ]

    const entry = (event: AssistantEvent.AssistantEvent, i: number) =>
      AssistantEvent.Entry.make({ chatId, seq: i + 1, at: 0, event })

    const entries = events.map(entry)

    expect(BlockKit.staleBlocks(entries, { messages: 3 })).toEqual(["m1"])

    // Work waits on a decision block, so typing past it leaves it open.
    const decision = AssistantEvent.MessageBlock.make({
      kind: Decision.kind,
      props: { decisionIds: ["decision:1"] }
    })

    const deciding = [message("d1", decision), say("a"), say("b"), say("c")].map(entry)

    expect(BlockKit.staleBlocks(deciding, { messages: 3 })).toEqual([])

    const closed = [...entries, entry(AssistantEvent.BlocksClosed.make({ messageIds: ["m1"] }), entries.length)]

    expect(BlockKit.blockStates(closed).get("m1")).toEqual({ open: false, answer: undefined })
    expect(BlockKit.blockStates(closed).get("m2")?.open).toBe(true)
  })
})
