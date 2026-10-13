# The chat client

A chat client gets the chat as its user sees it, and nothing else: the
user's messages, the assistant's messages with their blocks, the app's own
events you let through, and whether the assistant (or one of its specialists)
is working. Never the model's output, tool calls or results, what the model
read, or why a turn failed. That's [`ChatView`](/api/ChatView).

The assistant's `subscribe(chatId)` (`yield* MyAssistant`) streams the chat's
log; pipe it through
[`ChatView.updates(MyAssistant)`](/api/ChatView#updates) to stream the view
as [`ChatView.Update`](/api/ChatView#update)s: each one has the messages
that are new or changed since the last (whole), and the activity now. The
definition gives the fold the schemas of the app's events (see
[your events in the view](#your-events-in-the-view)). Updates are JSON. The
client folds them with [`ChatView.apply(MyAssistant)`](/api/ChatView#apply),
from `ChatView.empty`, which decodes the assistant's events and types the
view with them: the client imports the definition too, so keep it
client-safe (its schemas, blocks, and specialists, not its handlers).

## Over RPC

`ChatView.Update` is a schema, so an RPC streams it as it is:

```ts
import { AssistantEvent, ChatId, ChatView } from "effect-assistant"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

// Shared by the server and the client.
export const Subscribe = Rpc.make("Subscribe", {
  payload: { chatId: ChatId.ChatId },
  success: ChatView.Update,
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
const view = client("Subscribe", { chatId }).pipe(Stream.scan(() => ChatView.empty, ChatView.apply(MyAssistant)))
```

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
MyAssistant)` makes the whole view as one `ChatView.Update` on the server,
and the client applies it to `ChatView.empty`. Server code that reads the
view itself uses `ChatView.fromEntries(entries, MyAssistant)`, typed the
same way.

## What's in a view

- **`messages`**: `UserMessage`s and `AssistantMessage`s, in order, each
  with `at` (epoch milliseconds). An assistant's message has its `block`,
  if it has one: its `kind` and `props`, its `status` (`"open"`,
  `"answered"`, or `"closed"`), and the user's `answer`. Between them, a row
  for each of your events the view got (see below).
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
what the user sees, and the definition gives it the schemas of the
assistant's events.

## Your events in the view

**The view shows every app event it gets.** Each one becomes a row in
`messages`, in the log's order between the messages, so filter `subscribe` to
the events your users may see before `ChatView.updates`: a summary for
compaction, say, would reach the client otherwise.

```ts
import { AssistantEvent, ChatView } from "effect-assistant"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

const watch = (chatId: ChatId.ChatId) =>
  assistant.subscribe(chatId).pipe(
    Stream.filter(({ event }) => AssistantEvent.isLibraryEvent(event) || Schema.is(DailyBudgetReached)(event)),
    ChatView.updates(MyAssistant)
  )
```

On the client, `ChatView.apply(MyAssistant)` decodes each row with its
event's schema. A row is a [`ChatView.EventRow`](/api/ChatView#eventrow): its
`_tag` is the event's, the decoded event is in `event`, and the row's `id`
(fixed per entry) and `at` sit beside it. The event isn't spread into the
row, since it may have an `id` of its own, and a class keeps its prototype.
So a match over the messages has one handler per event, beside the two
messages, typed with the assistant's events:

```tsx
import { type Assistant, ChatView } from "effect-assistant"
import * as Match from "effect/Match"

type MyView = ChatView.View<Assistant.Events<typeof MyAssistant>>

const items = (view: MyView) =>
  view.messages.map((message) =>
    Match.valueTags(message, {
      UserMessage: (sent) => <UserBubble key={sent.id} text={sent.text} />,
      AssistantMessage: (sent) => <AssistantBubble key={sent.id} message={sent} />,
      DailyBudgetReached: (row) => <BudgetNotice key={row.id} at={row.at} />,
      OrderPlaced: (row) => <OrderPlacedRow key={row.id} order={row.event} />,
      Summary: () => null // filtered out on the server; the types list every event of the assistant
    })
  )
```

A row whose event the client's definition doesn't have, or that doesn't
decode (an older client, say), is left out. `ChatView.fromEntries(entries,
MyAssistant)` and `ChatView.snapshot` show the same rows, so pass them only
the entries the user may see too.
