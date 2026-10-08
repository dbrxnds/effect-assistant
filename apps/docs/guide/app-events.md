# Your own events and background work

The assistant's log has the library's events, and the app's own: what a
workflow or a webhook reports, a summary for compaction, the draft the user
opened. The app registers each one with its assistant, with
[`AppEvent.make`](/api/AppEvent#make):

- **`wakes`**: whether storing one starts a turn, like a user's message.
  Yes for what background work reports, so the assistant can tell the user.
  No (the default) for the app's bookkeeping.
- **`render`**: how the model reads it in its history, a function of the
  event that returns the text. `"json"` is its tag and fields in JSON, which
  is the default for an event that wakes a turn. One that doesn't wake a
  turn and has no `render` isn't read, unless a
  [history view](./loops#compaction) puts it in.

The user sees none of them: only what the assistant sends reaches the user
(see [the chat client](./client)). So a rendered event can say what the
assistant should do with it ("tell the user if it matters") and let the
assistant write the message.

**Example** (An order's progress wakes a turn; the draft the user opened doesn't)

```ts
import * as Schema from "effect/Schema"
import { AppEvent, Assistant, InputId } from "effect-assistant"

class OrderShipped extends Schema.TaggedClass<OrderShipped>()("OrderShipped", {
  id: InputId.InputId,
  orderId: Schema.String,
  carrier: Schema.String
}) {}

class DraftOpened extends Schema.TaggedClass<DraftOpened>()("DraftOpened", { draftId: Schema.String }) {}

export const MyAssistant = Assistant.make("my-assistant", {
  events: [
    AppEvent.make(OrderShipped, {
      wakes: true,
      render: (shipped) =>
        `<order id="${shipped.orderId}" status="shipped" carrier="${shipped.carrier}">The user hasn't seen this: tell them if it matters.</order>`
    }),
    AppEvent.make(DraftOpened, { render: (opened) => `The user opened draft ${opened.draftId}.` })
  ]
})
```

The assistant's `submit` (`yield* MyAssistant`) stores them like a user's
message. Code in the chat (the handler, its build, a tool its turns run)
reads and writes them through the assistant's chat, `yield* MyAssistant.Chat`:
its `entries` are typed with the assistant's events, and its `append` takes
only those and the library's. Anything else is a type error, for `submit` and
`append` alike. History views and the assistant's `subscribe` decode them to
their types too.

Code that doesn't know the assistant, like a tool shared by several, uses
`AssistantChat`: the same chat, with the events decoded but untyped (read
them with `Schema.is(MyEvent)`), and an `append` that fails the turn for an
event the assistant didn't register.

```ts
import { type ChatId, InputId } from "effect-assistant"

// A webhook: the order shipped.
const shipped = (chatId: ChatId.ChatId, orderId: string) =>
  MyAssistant.use((assistant) =>
    assistant.submit(chatId, OrderShipped.make({ id: InputId.fromKey(`${orderId}:shipped`), orderId, carrier: "DHL" }))
  )
```

An event with an `id` field (an `InputId`) is stored once per id: derive it
from what the event stands for, and a duplicate webhook is ignored (see
[input ids](./events#input-ids-make-retries-safe)).

## Long-running work

The pattern for slow work: a tool **starts** it and returns at once, and the
work reports back with events that wake a turn.

```ts
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import { AssistantChat, AssistantToolCall, RunId } from "effect-assistant"

const StartCampaign = Tool.make("start_campaign", {
  description: "Order a campaign. The run reports each step back as a <campaign> update.",
  parameters: Schema.Struct({ campaignId: Schema.String, budget: Schema.Finite }),
  success: Schema.Struct({ runId: RunId.RunId, status: Schema.Literal("started") }),
  dependencies: [AssistantChat.AssistantChat, AssistantToolCall.AssistantToolCall]
})

const CampaignToolsLive = Toolkit.make(StartCampaign).toLayer({
  start_campaign: Effect.fn(function* ({ campaignId, budget }) {
    const chat = yield* AssistantChat.AssistantChat
    const runId = RunId.fromKey(yield* AssistantToolCall.idempotencyKey)
    yield* CreateCampaign.execute({ runId, chatId: chat.chatId, campaignId, budget }, { discard: true })

    return { runId, status: "started" as const }
  })
})
```

With an Effect workflow (`effect/workflow`), report each step in an
`Activity`, so it runs once even when the workflow replays:

```ts
class CampaignStep extends Schema.TaggedClass<CampaignStep>()("CampaignStep", {
  id: InputId.InputId,
  runId: RunId.RunId,
  status: Schema.String
}) {}

const report = (payload: Payload, status: string) =>
  Activity.make({
    name: `Report:${status}`,
    execute: MyAssistant.use((assistant) =>
      assistant.submit(
        payload.chatId,
        CampaignStep.make({ id: InputId.fromKey(`${payload.runId}:${status}`), runId: payload.runId, status })
      )
    )
  })
```

Register `AppEvent.make(CampaignStep, { wakes: true, render })` on the
assistant. The assistant tells the user in one line that it started, and
follows up when the steps arrive. If a step needs something from the user,
its text says so, and the assistant asks, maybe with a [block](./blocks). An
approval belongs before the work starts: the tool that starts it needs a
[decision](./decisions).

The demo's workflows do this: `packages/demo/api/src/WorkflowStep.ts` and
`Steps.ts`.

If the chat is deleted while the work runs, what it reports is dropped,
quietly: the work goes on, and its reports do nothing (see
[deleting a chat](./chats#deleting-a-chat)).

## Whom an event acts for

An event's turn is for the chat's user, like every turn (see
[chats and users](./chats)). The workflow doesn't carry the user: it keeps
the chat id and submits an event. The handler looks the user up from
`turn.chatId`, as it does for a user's message.

## Evolving an event's schema

A log is kept for good, and an event's schema decodes every one stored with
it, in its JSON form (a `Date` or a `bigint` survives). Yours evolve in your
schema:

- A field added later is optional, or has a decoding default
  (`Schema.optionalKey(...)`, `Schema.withDecodingDefaultKey(...)`), so the
  events stored before it still decode.
- A change old events can't decode into is a new tag (`CampaignStepV2`).
  Keep the old one registered, with its `render`, so the chats that have it
  read as they did.
- An event that doesn't decode, like one whose tag is no longer registered,
  is left out: the model doesn't read it, `AssistantChat`'s `entries` and `subscribe` skip
  it, and it wakes nothing.
