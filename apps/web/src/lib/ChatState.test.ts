import * as ChatView from "effect-assistant/ChatView"
import * as InputId from "effect-assistant/InputId"
import * as Predicate from "effect/Predicate"
import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import * as ChatState from "./ChatState.ts"

const user = (id: string, text: string) => ChatView.UserMessage.make({ id: InputId.fromKey(id), text, at: 0 })

const update = (seq: number, messages: ReadonlyArray<ChatView.Message>, working: boolean): ChatView.Update => ({
  seq,
  messages,
  activity: { working, specialists: [] },
  failed: false,
  deleted: false
})

test("works while the view says the assistant or a specialist works", () => {
  assert.equal(ChatState.apply(ChatState.initial, update(1, [user("a", "hi")], true)).working, true)
  assert.equal(ChatState.apply(ChatState.initial, update(3, [], false)).working, false)

  const researching: ChatView.Update = {
    ...update(4, [], false),
    activity: { working: false, specialists: [{ specialist: "research", since: 0 }] }
  }

  assert.equal(ChatState.apply(ChatState.initial, researching).working, true)
})

test("a replayed update is applied once", () => {
  const first = update(1, [user("a", "hi")], true)
  const state = [first, first].reduce(ChatState.apply, ChatState.initial)

  assert.equal(state.messages.length, 1)
})

test("shows this tab's sends until the server has them, as working", () => {
  const sent = user("b", "and another thing")
  const state = ChatState.apply(ChatState.initial, update(2, [user("a", "hi")], false))

  const pending = ChatState.withPendingSends(state, [sent])

  assert.deepEqual(
    pending.messages.map((message) => (Predicate.isTagged(message, "AppEvent") ? message.tag : message.text)),
    ["hi", "and another thing"]
  )
  assert.equal(pending.working, true)

  const echoed = ChatState.apply(state, update(3, [sent], true))

  assert.equal(ChatState.withPendingSends(echoed, [sent]).messages.length, 2)
})
