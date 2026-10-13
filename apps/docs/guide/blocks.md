# UI blocks

A block is a bit of UI the assistant can put in a message when a structured answer
is easier than typing: options to pick from, a small input. It's only a
shortcut. The user can always type instead, and the assistant reads either.

A block collects input. Work the user must agree to, like placing an order,
is a tool call that waits for their approval instead (see
[involving the user](./user-involvement)). A block without an answer is a
card.

## Define a catalog

Blocks are defined once and shared by server and client.

**Example** (A choice)

```ts
import { Block, BlockKit } from "effect-assistant"
import * as Schema from "effect/Schema"

export const ChooseOne = Block.make("choose_one", {
  description: "Buttons for picking one of a few options. Keep options short.",
  props: Schema.Struct({ options: Schema.Array(Schema.String) }),
  answer: Schema.Struct({ choice: Schema.String })
})

export const Blocks = BlockKit.make([ChooseOne])
```

- `description` is what the assistant reads to decide when to use it.
- `props` is what the assistant fills in; it's checked when the assistant sends the message.
- `answer` is what the client sends back. Leave it out for display-only cards.

## On the server

Blocks are part of the assistant's definition, not its handler, so the UI and the
assistant share one catalog:

```ts
import { Assistant } from "effect-assistant"

export const MyAssistant = Assistant.make("my-assistant", { blocks: Blocks })
```

`send_user_message` now takes an optional block:
`send_user_message({ text, block: { kind: "choose_one", props: { options: [...] } } })`.
It's stored as an `AssistantMessage` with a `block`.

## On the client

The client gets the chat's [timeline](./client): each assistant message comes with
its block, and where the block stands.
[`BlockKit.toClient`](/api/BlockKit#toclient) maps each kind to a renderer.
It's type-checked, so every kind in the kit is covered, and each renderer gets
typed `props` and `answer`, and whether the block is `open`:

```tsx
const render = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
  choose_one: ({ props, open, answer, respond }) =>
    props.options.map((option) => (
      <button key={option} disabled={!open} onClick={() => respond({ choice: option })}>
        {answer?.choice === option ? `✓ ${option}` : option}
      </button>
    ))
})

// For each AssistantMessage on the timeline:
render(message, { respond: (answer) => submit(answer) })
```

`respond` builds a `BlockAnswer` input (encoding the answer with the block's
schema), which you `submit` like a message. The chat shows it inside the
block, not as a message. The renderer returns `undefined` for messages it
can't show; show just the text then.

## Showing a tool's result

Some UI is just what a tool returned: found items as cards, a download as a
button. Copying that into block props costs the model output tokens (a signed
link is hundreds), and a wrong character breaks it. A block made with
[`Block.fromToolResult`](/api/Block#fromtoolresult) shows the result itself:

```ts
import { Block, BlockKit } from "effect-assistant"
import { SearchItems } from "./tools.ts"

export const Blocks = BlockKit.make([ChooseOne, Block.fromToolResult(SearchItems)])
```

The tool's results then carry a `resultId` in what the model reads, and the
model shows one with a `tool_result` block:
`send_user_message({ text, block: { kind: "tool_result", props: { resultId: "r-1a2b3c4d" } } })`.
It never sees the block's kind or how the client draws it, and it decides
whether to show a result at all; the message text is the caption. An id the
chat has no successful result for fails back to the model.

The client gets the result with the message, and the renderer for the tool's
name gets it decoded by the tool's success schema:

```tsx
const render = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
  choose_one: …,
  search_items: ({ result }) => <ItemCards items={result.items} />
})
```

The tool's definition is shared with the client, so add server-only services
on the server with `Tool.addDependency`. The client gets the whole result:
only show tools whose results the user may see in full.

To keep fields only the UI needs (image URLs, file ids) out of the model's
context, give the tool a [model view](/api/ToolResult#modelview). The log keeps
the whole result:

```ts
export const SearchItems = ToolResult.modelView(
  Tool.make("search_items", { parameters, success: Schema.Struct({ items: Schema.Array(Item) }) }),
  (result) => ({ items: result.items.map(({ id, name }) => ({ id, name })) })
)
```

## Open and closed

A block stays open until it's answered: with the block itself, or in words.
When the user types the answer instead, the assistant lists the block's
message id in a later message's `closes`. Anything else the user sends, like another
block's answer or a question about something else, leaves it open. The
timeline's block `status` says which: `"open"`, `"answered"`, or `"closed"`
(without an answer). On the server,
[`BlockKit.fromEntries(entries)`](/api/BlockKit#fromentries) computes the
same from a log, and `BlockKit.apply` one event at a time.

In case the assistant doesn't close a block the user moved on from, the turn
can: `yield* BlockKit.closeStale({ messages: 3 })` in the handler, before
the loop, closes the blocks still open after three typed messages. It records a `BlocksClosed`
event, so every client folds them closed. `BlockKit.staleBlocks(entries,
{ messages: 3 })` finds them, for a loop of your own.

## Asking for things from outside

A workflow that needs something from the user doesn't build the UI. It notifies the
assistant with an [event](./app-events) that says what it needs ("ask which delivery
date works"), and the assistant writes the message and picks the block. Work the user must
agree to starts from a block's button, through your API (see
[involving the user](./user-involvement)).
