# UI blocks

A block is a bit of UI the assistant can put in a message when a structured answer
is easier than typing: options to pick from, approve/deny, a small input.
It's only a shortcut. The user can always type instead, and the assistant reads
either.

## Define a catalog

Blocks are defined once and shared by server and client.

**Example** (Two blocks)

```ts
import { Block, BlockKit } from "effect-assistant"
import * as Schema from "effect/Schema"

export const ChooseOne = Block.make("choose_one", {
  description: "Buttons for picking one of a few options. Keep options short.",
  props: Schema.Struct({ options: Schema.Array(Schema.String) }),
  answer: Schema.Struct({ choice: Schema.String })
})

export const Confirm = Block.make("confirm", {
  description: "Approve / deny buttons for a yes-or-no decision.",
  props: Schema.Struct({ confirmLabel: Schema.String, denyLabel: Schema.String }),
  answer: Schema.Struct({ confirmed: Schema.Boolean })
})

export const Blocks = BlockKit.make([ChooseOne, Confirm])
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

[`BlockKit.toClient`](/api/BlockKit#toclient) maps each kind to a renderer.
It's type-checked, so every kind in the kit is covered, and each renderer gets
typed `props` and `answer`:

```tsx
const render = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
  choose_one: ({ props, open, answer, respond }) =>
    props.options.map((option) => (
      <button key={option} disabled={!open} onClick={() => respond({ choice: option })}>
        {answer?.choice === option ? `✓ ${option}` : option}
      </button>
    )),
  confirm: ({ props, open, respond }) => (
    <>
      <button disabled={!open} onClick={() => respond({ confirmed: true })}>
        {props.confirmLabel}
      </button>
      <button disabled={!open} onClick={() => respond({ confirmed: false })}>
        {props.denyLabel}
      </button>
    </>
  )
})

// For each AssistantMessage:
render(message, { state: blockStates.get(message.id), respond: (answer) => submit(answer) })
```

`respond` builds a `BlockAnswer` input (encoding the answer with the block's
schema), which you `submit` like a message. The chat shows it inside the
block, not as a message. The renderer returns `undefined` for messages it
can't show; show just the text then.

## Open and closed

A block stays open until it's answered: with the block itself, or in words.
When the user types the answer instead, the assistant lists the block's
message id in a later message's `closes`. Anything else the user sends, like another
block's answer or a question about something else, leaves it open.
[`BlockKit.blockStates(entries)`](/api/BlockKit#blockstates) computes that
for a whole log, and `BlockKit.nextBlockStates` does it one event at a time
for clients that fold the stream.

In case the assistant doesn't close a block the user moved on from, the turn
can: `yield* BlockKit.closeStale({ messages: 3 })` in the handler, before
the loop, closes the blocks still open after three typed messages. It records a `BlocksClosed`
event, so every client folds them closed. `BlockKit.staleBlocks(entries,
{ messages: 3 })` finds them, for a loop of your own.

## Asking for things from outside

A workflow that needs the user's approval doesn't build the UI. It notifies the
assistant with a fact that says what it needs ("get the user's approval for the budget"), and
the assistant writes the message and picks the block.
