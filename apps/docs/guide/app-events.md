# Your own events and background work

The assistant's log has the library's events, and the app's own: what a
workflow or a webhook reports, a summary for compaction, the order the user
placed, a note that the daily budget ran out. The definition lists their
schemas, tagged structs or classes, and nothing else:

```ts
import * as Schema from "effect/Schema"
import { Assistant, InputId } from "effect-assistant"

class OrderShipped extends Schema.TaggedClass<OrderShipped>()("OrderShipped", {
  id: InputId.InputId,
  orderId: Schema.String,
  carrier: Schema.String
}) {}

class Summary extends Schema.TaggedClass<Summary>()("Summary", { text: Schema.String, throughSequence: Schema.Int }) {}

export const MyAssistant = Assistant.make("my-assistant", { events: [OrderShipped, Summary] })
```

What happens with an event is decided where it's used:

- **Whether it wakes a turn** depends on where it comes from. One that
  comes in through the assistant's `submit`, from outside a turn (a
  workflow, a webhook, your API), is an input, like a user's message: storing
  it wakes a turn. One a turn appends itself (`yield* MyAssistant.Chat`, then
  `append`), like a summary, never wakes one. The log marks which is which,
  so this holds after a restart too. The handler decides what each turn does:
  run the loop, or record something and return `Stream.empty`.
- **What the model reads** is up to your [history view](./loops#your-own-events):
  it maps the events the model should read to prompt messages. The model
  reads none by itself.
- **What the user sees** is up to `Timeline.changes(MyAssistant, { show })`:
  only the events it names reach the client's timeline, and none by default
  (see [the chat client](./client#your-events-on-the-timeline)).

**Example** (The model reads a shipment as a short note)

```ts
import * as Prompt from "effect/ai/Prompt"

const shipments: Assistant.HistoryView<OrderShipped | Summary> = (entries) =>
  entries.map((entry) =>
    entry.event instanceof OrderShipped
      ? Prompt.userMessage({
          content: [
            Prompt.textPart({
              text: `<order id="${entry.event.orderId}" status="shipped" carrier="${entry.event.carrier}">The user hasn't seen this: tell them if it matters.</order>`
            })
          ]
        })
      : entry
  )

const MyAssistantHandlers = MyAssistant.toLayer((turn) => turn.run({ instructions, history: shipments }))
```

The assistant's `submit` (`yield* MyAssistant`) stores them like a user's
message, and wakes a turn. Code in the chat (the handler, its build, a tool its turns run)
reads and writes them through the assistant's chat, `yield* MyAssistant.Chat`:
its `entries` are typed with the assistant's events, and its `append` takes
only those and the library's. Anything else is a type error, for `submit` and
`append` alike. History views and the assistant's `subscribe` decode them to
their types too.

Code that doesn't know the assistant, like a tool shared by several, uses
`CurrentChat`: the same chat, with the events decoded but untyped (read
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
import { AssistantToolCall, CurrentChat, RunId } from "effect-assistant"

const StartCampaign = Tool.make("start_campaign", {
  description: "Order a campaign. The run reports each step back as a <campaign> update.",
  parameters: Schema.Struct({ campaignId: Schema.String, budget: Schema.Finite }),
  success: Schema.Struct({ runId: RunId.RunId, status: Schema.Literal("started") }),
  dependencies: [CurrentChat.CurrentChat, AssistantToolCall.AssistantToolCall]
})

const CampaignToolsLive = Toolkit.make(StartCampaign).toLayer({
  start_campaign: Effect.fn(function* ({ campaignId, budget }) {
    const chat = yield* CurrentChat.CurrentChat
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

List `CampaignStep` in the assistant's `events`, and map it to a note in
its history view. Each step the workflow submits wakes a turn. The assistant
tells the user in one line that it started, and follows up when the steps
arrive. If a step needs something from the user, its note says so, and the
assistant asks, maybe with a [block](./blocks).
Work the user must agree to starts from a block's button instead, and your API
submits an event like these (see [involving the user](./user-involvement)).

The demo's workflows do this: `packages/demo/shared/src/WorkflowStep.ts` and
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
  Keep the old one in `events`, and in your history view, so the chats that
  have it read as they did.
- An event that doesn't decode, like one whose tag is no longer registered,
  is left out: the model doesn't read it, and `CurrentChat`'s `entries` and
  `subscribe` skip it.
