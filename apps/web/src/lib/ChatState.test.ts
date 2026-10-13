import * as Timeline from "effect-assistant/Timeline"
import * as InputId from "effect-assistant/InputId"
import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import * as ChatState from "./ChatState.ts"

const user = (id: string, text: string) => Timeline.UserMessage.make({ id: InputId.fromKey(id), text, at: 0 })

const change = (seq: number, items: ReadonlyArray<Timeline.Item>, working: boolean): Timeline.Change => ({
  seq,
  items,
  activity: { working, specialists: [] },
  failed: false,
  deleted: false
})

test("works while the timeline says the assistant or a specialist works", () => {
  assert.equal(ChatState.apply(ChatState.initial, change(1, [user("a", "hi")], true)).working, true)
  assert.equal(ChatState.apply(ChatState.initial, change(3, [], false)).working, false)

  const researching: Timeline.Change = {
    ...change(4, [], false),
    activity: { working: false, specialists: [{ specialist: "research", since: 0 }] }
  }

  assert.equal(ChatState.apply(ChatState.initial, researching).working, true)
})

test("a replayed change is applied once", () => {
  const first = change(1, [user("a", "hi")], true)
  const state = [first, first].reduce(ChatState.apply, ChatState.initial)

  assert.equal(state.items.length, 1)
})

test("shows this tab's sends until the server has them, as working", () => {
  const sent = user("b", "and another thing")
  const state = ChatState.apply(ChatState.initial, change(2, [user("a", "hi")], false))

  const pending = ChatState.withPendingSends(state, [sent])

  assert.deepEqual(
    pending.items.map((item) => item.text),
    ["hi", "and another thing"]
  )
  assert.equal(pending.working, true)

  const echoed = ChatState.apply(state, change(3, [sent], true))

  assert.equal(ChatState.withPendingSends(echoed, [sent]).items.length, 2)
})
