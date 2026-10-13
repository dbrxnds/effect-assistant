# The chat client

A chat client gets the chat as its user sees it, and nothing else: its
timeline. It has the user's messages, the assistant's messages with their
blocks, the app's own events you show, and whether the assistant (or one of
its specialists) is working. Never the model's output, tool calls or
results, what the model read, or why a turn failed. That's
[`Timeline`](/api/Timeline).

The assistant's `subscribe(chatId)` (`yield* MyAssistant`) streams the chat's
log; pipe it through
[`Timeline.changes(MyAssistant)`](/api/Timeline#changes) to stream the
timeline as [`Timeline.Change`](/api/Timeline#change)s: each one has the
items that are new or changed since the last (whole), and the activity now.
None of the app's own events are in it unless you `show` them (see
[your events on the timeline](#your-events-on-the-timeline)). The client
folds the changes with [`Timeline.fold`](/api/Timeline#fold), or one at a
time with [`Timeline.apply`](/api/Timeline#apply), from `Timeline.empty`.

## Over RPC

`Timeline.Change(events)` makes the schema an RPC streams: JSON, with an item
for each of the app events named, which the client decodes with their
schemas. `Timeline.Change()` has none:

```ts
import { AssistantEvent, ChatId, Timeline } from "effect-assistant"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

// Shared by the server and the client.
export const Subscribe = Rpc.make("Subscribe", {
  payload: { chatId: ChatId.ChatId },
  success: Timeline.Change(),
  stream: true
})

export const Submit = Rpc.make("Submit", {
  payload: { chatId: ChatId.ChatId, input: AssistantEvent.UserInput }
})

export const ChatRpcs = RpcGroup.make(Subscribe, Submit)
```

On the server, check the user may read the chat (see
[check access at the edge](./chats#check-access-at-the-edge)), then stream
its timeline:

```ts
const ChatRpcsLive = ChatRpcs.toLayer(
  Effect.gen(function* () {
    const assistant = yield* MyAssistant

    return ChatRpcs.of({
      Subscribe: ({ chatId }) => assistant.subscribe(chatId).pipe(Timeline.changes(MyAssistant)),
      Submit: ({ chatId, input }) => assistant.submit(chatId, input)
    })
  })
)
```

On the client, fold it:

```ts
const timelines = client("Subscribe", { chatId }).pipe(Timeline.fold)
```

The client doesn't need the assistant's definition: the RPC's schema
decodes the changes, and the timeline is typed with their events.
`Stream.scan(() => Timeline.empty, Timeline.apply)` folds them too, with the
timeline's type written out (`(): Timeline.Timeline<MyEvents> => Timeline.empty`):
TypeScript takes the state's type from `empty` before it sees the changes'.

A change that's applied twice changes nothing, so a client that
resubscribes from the start (after a dropped socket, say) folds again and
gets the same timeline. One that keeps its timeline can pass how far it is,
and gets only what changed since:

```ts
const since = (chatId: ChatId.ChatId, after: number) =>
  MyAssistant.useSync((assistant) => assistant.subscribe(chatId).pipe(Timeline.changes(MyAssistant, { after })))
```

`after` goes to `Timeline.changes`, not to `subscribe`. A message on the
timeline depends on what came before it (a block answered or closed later),
so the fold reads the whole log from the start and only skips emitting the
changes up to `after`. A `subscribe(chatId, { after })` would give it half a
log, and the timeline would be wrong.

For an RPC that returns a whole chat at once, `Timeline.snapshot(entries,
MyAssistant, { show })` makes the whole timeline as one change on the server,
and the client applies it to `Timeline.empty`. Server code that reads the
timeline itself uses `Timeline.fromEntries(entries, MyAssistant, { show })`.

## What's on a timeline

- **`items`**: `UserMessage`s and `AssistantMessage`s, in order, each
  with `at` (epoch milliseconds). An assistant's message has its `block`,
  if it has one: its `kind` and `props`, its `status` (`"open"`,
  `"answered"`, or `"closed"`), and the user's `answer`. Between them, an
  item for each of your events the timeline shows, and for each tool call
  waiting for the user's approval (see below).
- **`activity`**: `working` while a turn runs, or is about to start for
  something that arrived; `specialists`, the ones working (which, since
  when). `Timeline.isIdle(timeline)` is neither. A workflow waiting on a timer
  isn't working.
- **`failed`**: the last turn failed, and no message came after. Show
  something generic; the server's log says why.
- **`deleted`**: the chat was deleted. Nothing more arrives, and the stream
  ends.

The demo's web app (`apps/web/src/lib/ChatState.ts`) keeps nothing else:
the timeline, and the messages the tab sent that the server hasn't echoed
yet.

## Blocks

[`BlockKit.toClient`](/api/BlockKit#toclient) renders the block on an
assistant's message on the timeline: each renderer gets its typed `props`,
whether it's `open`, and the user's `answer`. See
[UI blocks](./blocks#on-the-client).

## The log is the server's

The assistant's `subscribe(chatId)` streams the whole log: every event, the
assistant's own work included. It's for server-side code, tests, and
debugging. Don't send it to a chat client: `Timeline.changes` turns it into
what the user sees.

## Your events on the timeline

None of your own events reach the client unless the server names them in
`show`: a summary for compaction stays the model's. The RPC's schema names
the same ones, and its type is what the handler must return, so a handler
that shows an event the schema doesn't name doesn't compile. Showing fewer
is fine.

```ts
// Shared: the user sees the budget notice, and nothing else of the app's.
export const Subscribe = Rpc.make("Subscribe", {
  payload: { chatId: ChatId.ChatId },
  success: Timeline.Change([DailyBudgetReached]),
  stream: true
})

// The server.
Subscribe: ({ chatId }) =>
  assistant.subscribe(chatId).pipe(Timeline.changes(MyAssistant, { show: [DailyBudgetReached] }))
```

Each shown event is an item on the timeline, in the log's order between the
messages: a [`Timeline.EventItem`](/api/Timeline#eventitem). Its `_tag` is
the event's, the decoded event is in `event`, and the item's `id` (fixed per
entry) and `at` sit beside it. The event isn't spread into the item, since
it may have an `id` of its own, and a class keeps its prototype. So a match
over the items has one handler per shown event, beside the two messages:

```tsx
import { Timeline } from "effect-assistant"
import * as Match from "effect/Match"

// The RPC shows the budget notice and the order placed.
const rows = (timeline: Timeline.Timeline<DailyBudgetReached | OrderPlaced>) =>
  timeline.items.map((item) =>
    Match.valueTags(item, {
      UserMessage: (sent) => <UserBubble key={sent.id} text={sent.text} />,
      AssistantMessage: (sent) => <AssistantBubble key={sent.id} message={sent} />,
      DailyBudgetReached: (budget) => <BudgetNotice key={budget.id} at={budget.at} />,
      OrderPlaced: (placed) => <OrderPlacedRow key={placed.id} order={placed.event} />
    })
  )
```

An item whose event the RPC's schema doesn't name, or that doesn't decode (a
newer server than the client, say), is left out of the change.
`Timeline.fromEntries` and `Timeline.snapshot` take the same `show`.

## Tool calls to approve

A call to a tool that needs the user's approval (see
[involving the user](./user-involvement)) is an item on the timeline too, a
[`Timeline.ApprovalItem`](/api/Timeline#approvalitem): `_tag: "ToolApproval"`,
the call's `id`, the `tool`'s name, its `status` (`"pending"`, `"approved"`,
`"rejected"`, or `"expired"`), the user's `reason` when they rejected it with
one, the `outcome` of an approved call once it ran, and `at`. A change
updates it in place as it's decided and run.

It's only the yes or no. The assistant's own message, sent with the call,
tells the user what it asks them to approve, so the item carries no params,
and the client needs nothing of the tool. Every call waiting for approval is
on the timeline, with no option on the RPC's schema or on `changes`.

[`ToolApproval.approve`](/api/ToolApproval#approve) and
[`ToolApproval.reject`](/api/ToolApproval#reject) build the decision to
submit, like a block's `respond` builds its answer:

```tsx
import { Timeline, ToolApproval } from "effect-assistant"
import * as Match from "effect/Match"

const row = (item: Timeline.Item<DailyBudgetReached>) =>
  Match.valueTags(item, {
    UserMessage: (sent) => <UserBubble key={sent.id} text={sent.text} />,
    AssistantMessage: (sent) => <AssistantBubble key={sent.id} message={sent} />,
    DailyBudgetReached: (budget) => <BudgetNotice key={budget.id} at={budget.at} />,
    ToolApproval: (approval) => (
      <ApproveOrReject
        key={approval.id}
        label={approval.tool}
        status={approval.status}
        onApprove={() => submit(ToolApproval.approve(approval))}
        onReject={(reason) => submit(ToolApproval.reject(approval, { reason }))}
      />
    )
  })
```
