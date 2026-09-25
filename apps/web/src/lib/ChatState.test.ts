import * as AssistantEvent from "effect-assistant/AssistantEvent"
import * as ChatId from "effect-assistant/ChatId"
import * as InputId from "effect-assistant/InputId"
import * as RunId from "effect-assistant/RunId"
import assert from "node:assert/strict"
import test from "node:test"
import * as ChatState from "./ChatState.ts"

const chatId = ChatId.make()

const fold = (events: ReadonlyArray<AssistantEvent.AssistantEvent>) =>
  events
    .map((event, i) => AssistantEvent.Entry.make({ chatId, seq: i + 1, at: 0, event }))
    .reduce(ChatState.apply, ChatState.initial(chatId))

const say = (text: string) => AssistantEvent.UserMessage.make({ id: InputId.make(), text })

test("works from a user message until the turn that read it ends", () => {
  assert.equal(fold([say("hi")]).working, true)
  assert.equal(fold([say("hi"), AssistantEvent.TurnStarted.make({})]).working, true)
  assert.equal(
    fold([say("hi"), AssistantEvent.TurnStarted.make({}), AssistantEvent.TurnCompleted.make({ throughSeq: 2 })])
      .working,
    false
  )
})

test("a turn that read the newest message ends working; an older one doesn't", () => {
  const events = [say("one"), AssistantEvent.TurnStarted.make({}), say("two")]

  assert.equal(fold([...events, AssistantEvent.TurnCompleted.make({ throughSeq: 2 })]).working, true)
  assert.equal(fold([...events, AssistantEvent.TurnCompleted.make({ throughSeq: 3 })]).working, false)
})

test("keeps working while a specialist runs after the turn", () => {
  const runId = RunId.make()

  const events = [
    say("research this"),
    AssistantEvent.TurnStarted.make({}),
    AssistantEvent.SpecialistStarted.make({ runId, specialist: "research" }),
    AssistantEvent.TurnCompleted.make({ throughSeq: 2 })
  ]

  assert.equal(fold(events).working, true)

  const stopped = AssistantEvent.SpecialistFinished.make({
    id: InputId.make(`${runId}:1`),
    runId,
    specialist: "research",
    brief: 1,
    goal: "research this",
    status: "stopped"
  })

  assert.equal(fold([...events, stopped]).working, false)
})

test("a block answer shows in its block, not as a message", () => {
  const block = AssistantEvent.MessageBlock.make({ kind: "choose_one", props: { options: ["a", "b"] } })

  const state = fold([
    AssistantEvent.AssistantMessage.make({ id: "m1", text: "Pick one", block }),
    AssistantEvent.BlockAnswer.make({ id: InputId.make(), messageId: "m1", kind: "choose_one", value: { choice: "a" } })
  ])

  assert.deepEqual(state.messages.map((message) => message.role), ["assistant"])
  assert.equal(state.blocks.get("m1")?.open, false)
  assert.equal(state.working, true)
})

test("replayed entries are applied once", () => {
  const entry = AssistantEvent.Entry.make({ chatId, seq: 1, at: 0, event: say("hi") })
  const state = ChatState.apply(ChatState.apply(ChatState.initial(chatId), entry), entry)

  assert.equal(state.messages.length, 1)
})
