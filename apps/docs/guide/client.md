# The chat client

A chat client gets the chat as its user sees it, and nothing else: the
user's messages, the assistant's messages with their blocks, the app's own
events you show, and whether the assistant (or one of its specialists)
is working. Never the model's output, tool calls or results, what the model
read, or why a turn failed. That's [`ChatView`](/api/ChatView).

The assistant's `subscribe(chatId)` (`yield* MyAssistant`) streams the chat's
log; pipe it through
[`ChatView.updates(MyAssistant)`](/api/ChatView#updates) to stream the view
as [`ChatView.Update`](/api/ChatView#update)s: each one has the messages
that are new or changed since the last (whole), and the activity now. None
of the app's own events are in it unless you `show` them (see
[your events in the view](#your-events-in-the-view)). The client folds the
updates with [`ChatView.views`](/api/ChatView#views), or one at a time with
[`ChatView.apply`](/api/ChatView#apply), from `ChatView.empty`.

## Over RPC

`ChatView.Update(events)` makes the schema an RPC streams: JSON, with a row
for each of the app events named, which the client decodes with their
schemas. `ChatView.Update()` has none:

```ts
import { AssistantEvent, ChatId, ChatView } from "effect-assistant"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

// Shared by the server and the client.
export const Subscribe = Rpc.make("Subscribe", {
  payload: { chatId: ChatId.ChatId },
  success: ChatView.Update(),
  stream: true
})

export const Submit = Rpc.make("Submit", {
  payload: { chatId: ChatId.ChatId, input: AssistantEvent.UserInput }
})

export const ChatRpcs = RpcGroup.make(Subscribe, Submit)
```

On the server, check the user may read the chat (see
[check access at the edge](./chats#check-access-at-the-edge)), then stream
its view:

```ts
const ChatRpcsLive = ChatRpcs.toLayer(
  Effect.gen(function* () {
    const assistant = yield* MyAssistant

    return ChatRpcs.of({
      Subscribe: ({ chatId }) => assistant.subscribe(chatId).pipe(ChatView.updates(MyAssistant)),
      Submit: ({ chatId, input }) => assistant.submit(chatId, input)
    })
  })
)
```

On the client, fold it:

```ts
const views = client("Subscribe", { chatId }).pipe(ChatView.views)
```

The client doesn't need the assistant's definition: the RPC's schema
decodes the updates, and the view is typed with their events.
`Stream.scan(() => ChatView.empty, ChatView.apply)` folds them too, with the
view's type written out (`(): ChatView.View<MyEvents> => ChatView.empty`):
TypeScript takes the state's type from `empty` before it sees the updates'.

An update that's applied twice changes nothing, so a client that
resubscribes from the start (after a dropped socket, say) folds again and
gets the same view. One that keeps its view can pass how far it is, and
gets only what changed since:

```ts
const since = (chatId: ChatId.ChatId, after: number) =>
  MyAssistant.useSync((assistant) => assistant.subscribe(chatId).pipe(ChatView.updates(MyAssistant, { after })))
```

`after` goes to `ChatView.updates`, not to `subscribe`. A message's view
depends on what came before it (a block answered or closed later), so the fold reads the whole log from the start and only skips
emitting the updates up to `after`. A `subscribe(chatId, { after })` would
give it half a log, and the view would be wrong.

For an RPC that returns a whole chat at once, `ChatView.snapshot(entries,
MyAssistant, { show })` makes the whole view as one update on the server,
and the client applies it to `ChatView.empty`. Server code that reads the
view itself uses `ChatView.fromEntries(entries, MyAssistant, { show })`.

## What's in a view

- **`messages`**: `UserMessage`s and `AssistantMessage`s, in order, each
  with `at` (epoch milliseconds). An assistant's message has its `block`,
  if it has one: its `kind` and `props`, its `status` (`"open"`,
  `"answered"`, or `"closed"`), and the user's `answer`. Between them, a row
  for each of your events the view shows (see below).
- **`activity`**: `working` while a turn runs, or is about to start for
  something that arrived; `specialists`, the ones working (which, since
  when). `ChatView.isIdle(view)` is neither. A workflow waiting on a timer
  isn't working.
- **`failed`**: the last turn failed, and no message came after. Show
  something generic; the server's log says why.
- **`deleted`**: the chat was deleted. Nothing more arrives, and the stream
  ends.

The demo's web app (`apps/web/src/lib/ChatState.ts`) keeps nothing else:
the view, and the messages the tab sent that the server hasn't echoed yet.

## Blocks

[`BlockKit.toClient`](/api/BlockKit#toclient) renders the block on an
assistant's message in the view: each renderer gets its typed `props`,
whether it's `open`, and the user's `answer`. See
[UI blocks](./blocks#on-the-client).

## The log is the server's

The assistant's `subscribe(chatId)` streams the whole log: every event, the
assistant's own work included. It's for server-side code, tests, and
debugging. Don't send it to a chat client: `ChatView.updates` turns it into
what the user sees.

## Your events in the view

None of your own events reach the client unless the server names them in
`show`: a summary for compaction stays the model's. The RPC's schema names
the same ones, and its type is what the handler must return, so a handler
that shows an event the schema doesn't name doesn't compile. Showing fewer
is fine.

```ts
// Shared: the user sees the budget notice, and nothing else of the app's.
export const Subscribe = Rpc.make("Subscribe", {
  payload: { chatId: ChatId.ChatId },
  success: ChatView.Update([DailyBudgetReached]),
  stream: true
})

// The server.
Subscribe: ({ chatId }) =>
  assistant.subscribe(chatId).pipe(ChatView.updates(MyAssistant, { show: [DailyBudgetReached] }))
```

Each shown event is a row in `messages`, in the log's order between the
messages: a [`ChatView.EventRow`](/api/ChatView#eventrow). Its `_tag` is the
event's, the decoded event is in `event`, and the row's `id` (fixed per
entry) and `at` sit beside it. The event isn't spread into the row, since it
may have an `id` of its own, and a class keeps its prototype. So a match
over the messages has one handler per shown event, beside the two messages:

```tsx
import { ChatView } from "effect-assistant"
import * as Match from "effect/Match"

// The RPC shows the budget notice and the order placed.
const items = (view: ChatView.View<DailyBudgetReached | OrderPlaced>) =>
  view.messages.map((message) =>
    Match.valueTags(message, {
      UserMessage: (sent) => <UserBubble key={sent.id} text={sent.text} />,
      AssistantMessage: (sent) => <AssistantBubble key={sent.id} message={sent} />,
      DailyBudgetReached: (row) => <BudgetNotice key={row.id} at={row.at} />,
      OrderPlaced: (row) => <OrderPlacedRow key={row.id} order={row.event} />
    })
  )
```

A row whose event the RPC's schema doesn't name, or that doesn't decode (a
newer server than the client, say), is left out of the update.
`ChatView.fromEntries` and `ChatView.snapshot` take the same `show`.
