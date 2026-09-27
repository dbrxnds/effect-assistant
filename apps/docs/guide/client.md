# The chat client

A chat client gets the chat as its user sees it, and nothing else: the
user's messages, the assistant's messages with their blocks, and whether the
assistant (or one of its specialists) is working. Never the model's output,
tool calls or results, what the model read, the app's own events, or why a
turn failed. That's [`ChatView`](/api/ChatView).

`MyAssistant.subscribeView(chatId)` streams it as
[`ChatView.Update`](/api/ChatView#update)s: each one has the messages that
are new or changed since the last (whole), and the activity now. The client
folds them with [`ChatView.apply`](/api/ChatView#apply), from `ChatView.empty`.

## Over RPC

`ChatView.Update` is a schema, so an RPC streams it as it is:

```ts
import { AssistantEvent, ChatId, ChatView } from "effect-assistant"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

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
    const engine = yield* AssistantEngine.AssistantEngine

    return ChatRpcs.of({
      Subscribe: ({ chatId }) =>
        MyAssistant.subscribeView(chatId).pipe(Stream.provideService(AssistantEngine.AssistantEngine, engine)),
      Submit: ({ chatId, input }) =>
        MyAssistant.submit(chatId, input).pipe(Effect.provideService(AssistantEngine.AssistantEngine, engine))
    })
  })
)
```

On the client, fold it:

```ts
const view = client("Subscribe", { chatId }).pipe(Stream.scan(() => ChatView.empty, ChatView.apply))
```

An update that's applied twice changes nothing, so a client that
resubscribes from the start (after a dropped socket, say) folds again and
gets the same view. One that keeps its view can pass how far it is,
`subscribeView(chatId, { after: view.seq })`, and gets only what changed
since.

`ChatView.View` is a schema too, for an RPC that returns a whole chat at
once; `ChatView.fromEntries(entries)` makes one from a log on the server.

## What's in a view

- **`messages`**: `UserMessage`s and `AssistantMessage`s, in order, each
  with `at` (epoch milliseconds). An assistant's message has its `block`,
  if it has one: its `kind` and `props`, its `status` (`"open"`,
  `"answered"`, or `"closed"`), the user's `answer`, and for a decision
  block its `decisions`, each with its `preview` and `outcome`.
- **`activity`**: `working` while a turn runs, or is about to start for
  something that arrived; `specialists`, the ones working (which, since
  when). `ChatView.isIdle(view)` is neither. A workflow waiting on a timer or
  a decision isn't working.
- **`failed`**: the last turn failed, and no message came after. Show
  something generic; the server's log says why.

The demo's web app (`apps/web/src/lib/ChatState.ts`) keeps nothing else:
the view, and the messages the tab sent that the server hasn't echoed yet.

## Blocks

[`BlockKit.toClient`](/api/BlockKit#toclient) renders the block on an
assistant's message in the view: each renderer gets its typed `props`,
whether it's `open`, the user's `answer`, and, for the decision block, its
`decisions`. See [UI blocks](./blocks#on-the-client).

## The log is the server's

`MyAssistant.subscribe(chatId)` streams the whole log: every event, the
assistant's own work included. It's for server-side code, tests, and
debugging. Don't send it to a chat client, and don't filter it for one:
`subscribeView` is that filter, and it knows the assistant's events.
