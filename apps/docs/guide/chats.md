# Chats and users

Whom a chat is for is your app's data. The library only knows chat ids: your
app keeps a chat table, checks access against it before it submits, and the
handler looks the user up from `turn.chatId` every turn.

Why not pass the user along with the message? A turn doesn't run inside the
request that caused it. `submit` stores the input and returns, and the turn
runs later, in the background, maybe again after a restart. Some turns have
no request at all: a specialist's answer, a workflow's event.

## Your app keeps the chats

The library only knows chat ids: a chat is its log, and it starts with its
first input. Keep your own chat table, keyed by chat id, with whatever your
app needs: the owner, a title, when it was created.

```ts
import { ChatId } from "effect-assistant"
import * as Effect from "effect/Effect"

const startChat = (userId: string) =>
  Effect.gen(function* () {
    const chatId = yield* ChatId.make
    yield* chats.insert({ chatId, ownerId: userId, title: "Spring campaign" })

    return chatId
  })
```

The demo's thread list is one: `packages/demo/api/src/Chats.ts`.

## Check access at the edge

The assistant doesn't know who is signed in; your request handler does.
Before it submits for a user, it checks the chat is theirs, against your
table:

```ts
import type { AssistantEvent, ChatId } from "effect-assistant"
import * as Effect from "effect/Effect"

const send = (userId: string, chatId: ChatId.ChatId, input: AssistantEvent.UserInput) =>
  Effect.gen(function* () {
    const chat = yield* chats.get(chatId)

    if (chat?.ownerId !== userId) return yield* Effect.fail("not_found" as const)

    yield* (yield* MyAssistant).submit(chatId, input)
  })
```

Answer "not found" for another user's chat, so it looks like one that
doesn't exist. Do the same before `subscribeView`.

## Look up the user in the handler

The handler looks the user up from `turn.chatId`, in the same table, and
provides what its tools need to its loop:

```ts
import { AssistantLoop, type ChatId } from "effect-assistant"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"

interface User {
  readonly name: string
  readonly admin: boolean
}

export class CurrentUser extends Context.Service<CurrentUser, User>()("app/CurrentUser") {}

/** Whose chat is it: a lookup in your chat table. */
export class ChatUsers extends Context.Service<
  ChatUsers,
  {
    readonly forChat: (chatId: ChatId.ChatId) => Effect.Effect<User>
  }
>()("app/ChatUsers") {}

// The tool declares what its handler uses at call time.
const Greet = Tool.make("greet", {
  description: "Greets the current user.",
  success: Schema.String,
  dependencies: [CurrentUser]
})

const greet = () => CurrentUser.useSync((user) => `hi ${user.name}`)

const UserTools = Toolkit.make(Greet)

const UserToolsLive = UserTools.toLayer({ greet })

const MyAssistantLive = MyAssistant.toLayer(
  Effect.gen(function* () {
    const users = yield* ChatUsers

    return (turn) =>
      Stream.unwrap(
        Effect.map(users.forChat(turn.chatId), (user) =>
          turn
            .loop({ instructions: `You help ${user.name}.`, toolkit: UserTools })
            .pipe(Stream.provideService(CurrentUser, user))
        )
      )
  })
).pipe(Layer.provide(UserToolsLive))
```

This works for every turn, however it started: a user's message, a
specialist's answer, a workflow's event, or a restart. The lookup is by chat,
so nothing has to carry the user.

`ChatUsers` is yielded in the build Effect, so it's a requirement of the
layer. `CurrentUser` isn't: the handler provides it to its stream. Without
that `Stream.provideService`, the `greet` tool's `CurrentUser` would be a
type error (see [what a handler may use](./assistant#what-a-handler-may-use)).

Look the user up every turn, not once: a turn after a restart, or one for a
workflow's event hours later, sees current permissions. It's one indexed query, and a
turn takes seconds of model calls, so it needs no cache. If it ever matters,
look it up once in the build, which runs once per chat activation, and
accept that permissions can be a few idle minutes old.

## Tools per user

The handler runs every turn with the user in hand, so which tools a turn
gets is plain code:

```ts
const MyAssistantLive = MyAssistant.toLayer(
  Effect.gen(function* () {
    const users = yield* ChatUsers

    return (turn) =>
      Stream.unwrap(
        Effect.map(users.forChat(turn.chatId), (user) =>
          (user.admin
            ? turn.loop({ instructions, toolkit: AdminTools }) // Toolkit.make(AdminReport, Greet)
            : turn.loop({ instructions, toolkit: UserTools })
          ).pipe(Stream.provideService(CurrentUser, user))
        )
      )
  })
).pipe(Layer.provide(AdminToolsLive)) // both toolkits' handlers: admin_report and greet
```

The model only sees the tools the turn got, so it can't call one the user
may not use. [Discovery](./tools#many-tools-discovery) works the same way:
build it over the tools the user may use. Still check
permissions in the tool, or in the service it calls, if that's where the
rest of your app enforces them.

## Specialists

A [specialist](./specialists) run works in the chat that spawned it. Its
handler does the same lookup from `run.chatId`:

```ts
const ResearchLive = Research.toLayer(
  Effect.gen(function* () {
    const users = yield* ChatUsers

    return (run) =>
      Stream.unwrap(
        Effect.map(users.forChat(run.chatId), (user) =>
          run
            .loop({
              instructions: "Answer with the findings and numbers the colleague needs, in a few short lines.",
              toolkit: OrderTools
            })
            .pipe(Stream.provideService(CurrentUser, user))
        )
      )
  })
).pipe(Layer.provide(OrderToolsLive))
```

The turn for its answer is in the same chat, so it finds the same user.

## Workflows

A workflow that reports back just calls `submit` with the chat id and one of
the assistant's [events](./app-events). It doesn't carry the user: the
handler looks the user up from the chat, as for any turn. See
[whom an event acts for](./app-events#whom-an-event-acts-for).

## Which chats exist

Provide `Chats`, and the assistant asks your app whether a chat exists:
`get(chatId)` returns the chat, or fails with `GetChatError` and a
`reason`, `"NotFound"` or `"Deleted"`. When a chat is created is yours to
decide: up front (and `get` fails for one you don't know), or on its first
message (and `get` creates it). Without `Chats`, every chat exists from
its first input.

The assistant asks before `submit` sends (so `submit` fails with
`GetChatError`, which your server can turn into a 404), when the chat
stores an input, and before every model call. Provide it where you provide
the log, so the engine and your server see the same one.

## Deleting a chat

When the user deletes a chat, mark it deleted in your table, then delete it
from the assistant:

```ts
const deleteChat = (userId: string, chatId: ChatId.ChatId) =>
  Effect.gen(function* () {
    const chat = yield* chats.get(chatId)

    if (chat?.ownerId !== userId) return yield* Effect.fail("not_found" as const)

    yield* chats.markDeleted(chatId)
    yield* (yield* MyAssistant).delete(chatId)
  })
```

The assistant's `delete` goes through the engine to the chat, which:

- appends a `ChatDeleted` to its log, which stays;
- stops what works in it: a turn, specialist runs, what the handler's build
  set up;
- ends its subscribers' streams after they get the `ChatDeleted`, and a
  client's view says `deleted: true`.

After that the chat stores nothing, also after a restart: a later input, a
specialist's report, or a workflow's event for it is dropped, quietly (no
turn). Work that reports into it, like a workflow, goes on and
ends as it would; what it reports does nothing. Deleting a chat again does
nothing.

If your app marks a chat deleted and never calls `delete`, the assistant
finds out from [`Chats`](#which-chats-exist) the next time it asks, and
deletes it the same way.

The log stays: removing old logs is yours, like your own records about the
chat (orders it placed, say). The demo deletes a thread's orders with it
(`packages/demo/api/src/Server.ts`).
