# Chats and users

Whom a chat is for is your app's data. The library only knows chat ids: your
app keeps a chat table, checks access against it before it submits, and the
handler looks the user up from `turn.chatId` every turn.

Why not pass the user along with the message? A turn doesn't run inside the
request that caused it. `submit` stores the input and returns, and the turn
runs later, in the background, maybe again after a restart. Some turns have
no request at all: a specialist's answer, a workflow's fact.

## Your app keeps the chats

The library only knows chat ids: a chat is its log, and it starts with its
first input. Keep your own chat table, keyed by chat id, with whatever your
app needs: the owner, a title, when it was created.

```ts
import { ChatId } from "effect-assistant"
import * as Effect from "effect/Effect"

const startChat = (userId: string) =>
  Effect.gen(function* () {
    const chatId = ChatId.make()
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

const send = (userId: string, chatId: ChatId.ChatId, input: AssistantEvent.ClientInput) =>
  Effect.gen(function* () {
    const chat = yield* chats.get(chatId)

    if (chat?.ownerId !== userId) return yield* Effect.fail("not_found" as const)

    yield* MyAssistant.submit(chatId, input)
  })
```

Answer "not found" for another user's chat, so it looks like one that
doesn't exist. Do the same before `subscribe`.

## Look up the user in the handler

The handler looks the user up from `turn.chatId`, in the same table, and
provides what its tools need to its loop:

```ts
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import type { ChatId } from "effect-assistant"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

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

const greet = Tool.make({
  name: "greet",
  description: "Greets the current user.",
  inputSchema: Tool.noInput,
  run: () => Effect.map(CurrentUser, (user) => `hi ${user.name}`)
})

const MyAssistantLive = MyAssistant.toLayer(
  Effect.gen(function* () {
    const users = yield* ChatUsers

    return (turn) =>
      Stream.unwrap(
        Effect.map(users.forChat(turn.chatId), (user) =>
          turn
            .loop({
              model: "claude-sonnet-5",
              instructions: `You help ${user.name}.`,
              toolkit: Toolkit.make(greet)
            })
            .pipe(Stream.provideService(CurrentUser, user))
        )
      )
  })
)
```

This works for every turn, however it started: a user's message, a
specialist's answer, a workflow's fact, or a restart. The lookup is by chat,
so nothing has to carry the user.

`ChatUsers` is yielded in the build Effect, so it's a requirement of the
layer. `CurrentUser` isn't: the handler provides it to its stream. Without
that `Stream.provideService`, the `greet` tool's `CurrentUser` would be a
type error (see [what a handler may use](./assistant#what-a-handler-may-use)).

Look the user up every turn, not once: a turn after a restart, or one for a
fact hours later, sees current permissions. It's one indexed query, and a
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
          turn
            .loop({
              model: "claude-sonnet-5",
              instructions,
              toolkit: user.admin ? Toolkit.make(adminReport, greet) : Toolkit.make(greet)
            })
            .pipe(Stream.provideService(CurrentUser, user))
        )
      )
  })
)
```

The model only sees the tools the turn got, so it can't call one the user
may not use. Tools found on demand work the same way: build
`ToolDiscovery.make(...)` over the tools the user may use. Still check
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
              model: "claude-sonnet-5",
              instructions: "Answer with the findings and numbers the colleague needs, in a few short lines.",
              toolkit: Toolkit.make(orderHistory)
            })
            .pipe(Stream.provideService(CurrentUser, user))
        )
      )
  })
)
```

The turn for its answer is in the same chat, so it finds the same user.

## Workflows

A workflow that reports back just calls `submit` with the chat id and a fact. It
doesn't carry the user: the handler looks the user up from the chat, as for
any turn. See [facts](./facts#whom-a-fact-acts-for).
