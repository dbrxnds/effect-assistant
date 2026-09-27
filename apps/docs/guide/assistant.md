# Assistants and handlers

An assistant is a **definition** and a **handler**, run by an **engine**:
the same split as an Effect workflow (`Workflow.make`, `toLayer`,
`WorkflowEngine`).

**Example** (A definition and its handler)

```ts
import { Assistant } from "effect-assistant"

export const MyAssistant = Assistant.make("my-assistant")

export const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
  turn.loop({ model: "claude-sonnet-5", instructions: "You help a small marketing team." })
)
```

## The definition

`Assistant.make(name, options?)` is what the rest of your app imports:
the server calls `submit` and `subscribe` on it, and the UI reads
its blocks. It holds no code that runs turns.

```ts
export const MyAssistant = Assistant.make("my-assistant", {
  blocks: Blocks, // UI the assistant may put in messages: see UI blocks
  specialists: [Research], // agents it may hand work to: see Specialists
  events: [Summary] // events of your own: see the event log
})
```

| Member               | What it does                                                                  |
| -------------------- | ----------------------------------------------------------------------------- |
| `submit(chatId, in)` | Stores an input and returns: a message, a block answer, or a [fact](./facts). |
| `subscribe(chatId)`  | Streams the chat's [events](./events): stored ones first, then live ones.     |
| `toLayer(handler)`   | The handler's layer. It registers the assistant with the [engine](./engines). |

The name is also the assistant's name in [traces](./observability)
(`invoke_agent my-assistant`) and, with the cluster engine, in its entity type.

## The handler

A handler is a function of the [`Turn`](/api/Assistant#turn) that returns the
turn as a stream of what the model did. Usually that's `turn.loop(...)`: the
agent loop with the assistant's own tools, the colleague rules, and the chat's
history wired in.

`turn.loop` takes:

| Option         | What it is                                                                        |
| -------------- | --------------------------------------------------------------------------------- |
| `model`        | The model to call, by the name the `LanguageModel` layer knows it by.             |
| `instructions` | The assistant's role and rules: text, or [resolved instructions](./instructions). |
| `toolkit`      | Its [tools](./tools), next to its own.                                            |
| `skills`       | [Playbooks](./skills) it loads when a task matches.                               |
| `maxSteps`     | Model calls per turn. Default 16.                                                 |

`turn.loop` ends with `turn.replyIfOwed`, so a user who asked something gets
an answer (see [a reply to every message](./turns#a-reply-to-every-message)).

The turn also has the pieces `turn.loop` is built from, for handlers that run
the loop themselves (see [custom loops](./loops)):

| Field                  | What it is                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `chatId`               | The chat the turn is for.                                                                       |
| `history`              | The model's history, rebuilt from the chat's log each time you read it.                         |
| `entries`              | The chat's entries, with the assistant's [own events](./events#your-own-events) decoded.        |
| `append(...events)`    | Writes the assistant's own events to the chat's log.                                            |
| `tools`                | The assistant's own tools: `send_user_message`, `wait`, and the specialist tools.               |
| `instructions(text)`   | The full system prompt: `Instructions.protocol`, the text, and the specialist runs working now. |
| `replyIfOwed(options)` | One more pass, reply-only, when the user's latest message has no reply.                         |

## Code that runs per chat

`toLayer` also takes an Effect that returns the handler: a build. Like an
Effect cluster entity's, the build runs once per chat activation, when the
chat wakes up (a message, a specialist's report, a workflow's fact), and its
scope closes when the chat goes idle. The handler it returns runs every turn.
Inside the build, `AssistantChat` says which chat it is.

**Example** (Setup per chat, work every turn)

```ts
import { AssistantChat } from "effect-assistant"

const MyAssistantHandlers = MyAssistant.toLayer(
  Effect.gen(function* () {
    const { chatId } = yield* AssistantChat.AssistantChat // the chat this build is for
    const catalog = yield* Catalog // your service, from the layer
    yield* Effect.addFinalizer(() => Effect.log(`${chatId} went idle`)) // when the chat closes

    return Effect.fn(function* (turn: Assistant.Turn) {
      const summary = yield* catalog.summary // every turn

      return turn.loop({
        model: "claude-sonnet-5",
        instructions: `You help a small marketing team. We sell: ${summary}`
      })
    })
  })
)
```

What the build sets up lives while the chat is active. Anything that must be
current every turn, like a user's permissions, belongs in the handler.

The handler may return the stream from an Effect, as here: that's how it
reads services, [looks up the user](./chats), or fetches its
[prompt](./instructions) before the loop starts.

## What a handler may use

A turn doesn't run inside the request that caused it, so a handler can't use
just any service in scope. It may use:

- the turn's services, `Assistant.TurnServices`: `AssistantChat` (the chat:
  its id, its entries, and its writer) and `Specialist.Runner`;
- `LanguageModel`;
- what its build Effect required, like `Catalog` above. Those become the
  layer's requirements, and you provide them the usual way;
- what it provides to its own stream, like a user it
  [looked up](./chats#look-up-the-user-in-the-handler).

The same goes for its tools and skills. Anything else is a type error that
names the missing services. For a tool's own services, see
[tools that use services](./tools#tools-that-use-services).

## The model

The handler names the model, and the loop calls whatever effect-uai
`LanguageModel` the layer is given: `Anthropic.layer` in these docs. Swap the
layer for another provider, or name a smaller model, as the
[tests](./testing) do.

## What the layer needs

`MyAssistant.toLayer(...)` is a layer that needs:

- `AssistantEngine`, which runs the chats (see [engines](./engines));
- `LanguageModel`, the model API;
- each of its specialists' handlers (`Research.toLayer(...)`);
- what its build Effect required.

`submit` and `subscribe` need `AssistantEngine` too, so provide the
engine with `Layer.provideMerge`, where your server can reach it.
