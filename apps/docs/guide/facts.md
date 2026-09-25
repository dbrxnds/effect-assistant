# Facts and background work

A [`Fact`](/api/AssistantEvent#fact) is an input the user didn't type: a
workflow step, a webhook. (A specialist's report has its own input,
[`SpecialistFinished`](./specialists).) `submit` stores one like
a user's message; only the input's type differs.

**Example** (A webhook tells the assistant)

```ts
import { AssistantEvent, type ChatId, InputId } from "effect-assistant"

const shipped = (chatId: ChatId.ChatId, orderId: string) =>
  MyAssistant.submit(
    chatId,
    AssistantEvent.Fact.make({
      id: InputId.make(`${orderId}:shipped`),
      source: "webhook:Shipping",
      payload: { orderId, status: "shipped", carrier: "DHL" }
    })
  )
```

The assistant sees it as `<fact source="webhook:Shipping">…</fact>` in its
history. The user doesn't see it: the assistant decides whether they need to
know (see [telling the user](./turns#telling-the-user-or-keeping-it-internal)).

The id is derived from what the fact stands for, so a duplicate webhook is
ignored (see [input ids](./events#input-ids-make-retries-safe)).

## Long-running work

The pattern for slow work: a tool **starts** it and returns at once, and the
work reports back with facts.

```ts
const StartInput = Schema.Struct({ campaignId: Schema.String, budget: Schema.Finite })

const startCampaign = Tool.make({
  name: "start_campaign",
  description: "Order a campaign. The run reports each step back as a fact.",
  inputSchema: StartInput,
  run: Effect.fn(function* ({ campaignId, budget }: typeof StartInput.Type) {
    const turn = yield* AssistantTurn.AssistantTurn
    const runId = RunId.make()
    yield* CreateCampaign.execute({ runId, chatId: turn.chatId, campaignId, budget }, { discard: true })
    return { runId, status: "started" }
  })
})
```

With an Effect workflow (`effect/unstable/workflow`), report each step in an
`Activity`, so it runs once even when the workflow replays:

```ts
const report = (payload: Payload, status: string) =>
  Activity.make({
    name: `Report:${status}`,
    execute: MyAssistant.submit(
      payload.chatId,
      AssistantEvent.Fact.make({
        id: InputId.make(`${payload.runId}:${status}`),
        source: "workflow:CreateCampaign",
        payload: { runId: payload.runId, status }
      })
    )
  })
```

The assistant tells the user in one line that it started, and follows up when the
facts arrive. If a step needs the user (an approval), the fact says so, and
the assistant asks, maybe with a confirm [block](./blocks).

## Whom a fact acts for

A fact's turn is for the chat's user, like every turn (see
[chats and users](./chats)). The workflow doesn't carry the user: it keeps
the chat id and submits a fact. The handler looks the user up from
`turn.chatId`, as it does for a user's message.
