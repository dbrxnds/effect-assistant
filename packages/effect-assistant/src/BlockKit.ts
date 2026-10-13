/**
 * Groups the blocks an assistant may put in its messages, and renders them on the client.
 *
 * A kit is created with {@link make} and passed to `Assistant.make`. {@link fromEntries} computes
 * the state of every message's block from a chat's log, {@link closeStale} closes the blocks the
 * user moved on from, and {@link toClient} creates a client-side renderer with one function per
 * block kind.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as AssistantEvent from "./AssistantEvent.ts"
import * as Block from "./Block.ts"
import type * as Timeline from "./Timeline.ts"
import { CurrentChat } from "./CurrentChat.ts"

/**
 * Represents a catalog of blocks, with a lookup by kind.
 *
 * @category models
 * @since 0.1.0
 */
export interface BlockKit<Blocks extends Block.Any = Block.Any> {
  readonly blocks: ReadonlyArray<Blocks>
  readonly byKind: ReadonlyMap<string, Blocks>
}

/**
 * Creates a kit from blocks.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <const Blocks extends ReadonlyArray<Block.Any>>(blocks: Blocks): BlockKit<Blocks[number]> => ({
  blocks,
  byKind: new Map(blocks.map((block) => [block.kind, block]))
})

type KindOf<B> = B extends { readonly kind: infer K extends string } ? K : never

type BlockOf<Kit extends BlockKit, K> = Extract<Kit["blocks"][number], { readonly kind: K }>

type PropsOf<B> = B extends { readonly props: Schema.Top } ? B["props"]["Type"] : never

type AnswerOf<B> = B extends { readonly answer: infer A } ? (A extends Schema.Top ? A["Type"] : never) : never

/**
 * Represents the state of a message's block.
 *
 * @category models
 * @since 0.1.0
 */
export interface State {
  readonly open: boolean
  /** The user's answer, if they used the block. */
  readonly answer: AssistantEvent.BlockAnswer | undefined
}

/**
 * Returns the block states after one more event.
 *
 * @category utils
 * @since 0.1.0
 */
export const apply = (
  states: ReadonlyMap<string, State>,
  event: { readonly _tag: string }
): ReadonlyMap<string, State> => {
  if (!AssistantEvent.isLibraryEvent(event)) return states

  const close = (ids: ReadonlyArray<string>) => {
    const open = ids.filter((id) => states.get(id)?.open === true)

    if (open.length === 0) return states

    const next = new Map(states)

    for (const id of open) next.set(id, { open: false, answer: undefined })

    return next
  }

  if (Predicate.isTagged(event, "BlocksClosed")) return close(event.messageIds)

  if (Predicate.isTagged(event, "AssistantMessage")) {
    const closed = close(event.closes ?? [])

    return event.block === undefined ? closed : new Map(closed).set(event.id, { open: true, answer: undefined })
  }

  if (!Predicate.isTagged(event, "BlockAnswer") || states.get(event.messageId)?.open !== true) return states

  return new Map(states).set(event.messageId, { open: false, answer: event })
}

/**
 * Returns the state of every message's block, by message id.
 *
 * @category utils
 * @since 0.1.0
 */
export const fromEntries = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): ReadonlyMap<string, State> => {
  let states: ReadonlyMap<string, State> = new Map()

  for (const entry of entries) states = apply(states, entry.event)

  return states
}

/**
 * Returns the ids of the messages whose blocks are still open after the user typed the given
 * number of messages without using them.
 *
 * **Details**
 *
 * These are the blocks {@link closeStale} closes.
 *
 * @category utils
 * @since 0.1.0
 */
export const staleBlocks = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  options: { readonly messages: number }
): ReadonlyArray<string> => {
  const open = [...fromEntries(entries)].flatMap(([id, state]) => (state.open ? [id] : []))

  return open.filter((id) => {
    const shown = entries.findIndex(
      ({ event }) =>
        AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "AssistantMessage") && event.id === id
    )

    if (shown === -1) return false

    const typed = entries.slice(shown + 1).filter(({ event }) => Predicate.isTagged(event, "UserMessage")).length

    return typed >= options.messages
  })
}

/**
 * Closes the blocks the user moved on from, which are still open after the given number of typed
 * messages.
 *
 * **Details**
 *
 * Run it from a turn, before or after its loop. It records a `BlocksClosed` event, so every
 * client folds the blocks closed.
 *
 * @see {@link staleBlocks} for the blocks it closes
 *
 * @category utils
 * @since 0.1.0
 */
export const closeStale = Effect.fn(function* (options: { readonly messages: number }) {
  const chat = yield* CurrentChat
  const stale = staleBlocks(yield* chat.entries, options)

  if (stale.length > 0) yield* chat.append(AssistantEvent.BlocksClosed.make({ messageIds: stale }))
})

/**
 * Represents what a renderer receives for one block.
 *
 * @category models
 * @since 0.1.0
 */
export interface RenderArgs<B> {
  /**
   * The id of the message the block is on. A block whose button calls your API can key the work
   * on it, with the chat's id, so the work runs once per block.
   */
  readonly messageId: string
  readonly text: string
  readonly props: PropsOf<B>
  /**
   * Whether the block is open. It is `false` once the block is answered, with the block or in
   * words; show it read-only then.
   */
  readonly open: boolean
  /** The user's answer, if they used the block. */
  readonly answer: AnswerOf<B> | undefined
  /** Sends an answer. Only call it while `open`. */
  readonly respond: (answer: AnswerOf<B>) => void
}

/**
 * Represents a renderer for every kind in a kit.
 *
 * @category models
 * @since 0.1.0
 */
export type Renderers<Kit extends BlockKit, Out> = {
  readonly [K in KindOf<Kit["blocks"][number]>]: (args: RenderArgs<BlockOf<Kit, K>>) => Out
}

/**
 * Represents the options for rendering one message's block.
 *
 * @category models
 * @since 0.1.0
 */
export interface RenderOptions {
  /** Submits an answer, for example over RPC. */
  readonly respond: (answer: AssistantEvent.BlockAnswer) => void
}

/**
 * Creates a client-side renderer for the blocks on the assistant's messages in a chat's timeline
 * (`Timeline.AssistantMessage`).
 *
 * **Details**
 *
 * The renderers are type-checked, so every kind in the kit needs one, and each receives typed
 * `props` and `answer`. A renderer's `respond` builds a `BlockAnswer` input with `Block.answer`,
 * and passes it to the `respond` option to submit.
 *
 * The returned function returns `undefined` for a message without a block, or with a block it
 * can't decode or has no renderer for.
 *
 * **Example** (Rendering blocks with React)
 *
 * ```tsx
 * import { BlockKit } from "effect-assistant"
 * import type { ReactNode } from "react"
 *
 * const Blocks = BlockKit.make([PickOne, OrderDraft])
 *
 * const renderBlock = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
 *   pick_one: ({ props, open, respond }) =>
 *     props.options.map((option) => (
 *       <button key={option} disabled={!open} onClick={() => respond({ picked: option })}>
 *         {option}
 *       </button>
 *     )),
 *   // The button calls the app's own API with the props the user sees; the API answers the block
 *   // with `Block.answer` once the order is placed.
 *   order_draft: ({ messageId, props, open }) => (
 *     <button disabled={!open} onClick={() => placeOrder(messageId, props)}>Place order</button>
 *   )
 * })
 *
 * // For each AssistantMessage in the chat's timeline:
 * renderBlock(message, { respond: (answer) => submit(answer) })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export function toClient<Kit extends BlockKit, Out>(
  kit: Kit,
  renderers: Renderers<Kit, Out>
): (message: Timeline.AssistantMessage, options: RenderOptions) => Out | undefined
// The overload above checks that every kind has a renderer; here each one takes any block's
// arguments.
export function toClient<Out>(
  kit: BlockKit,
  renderers: Readonly<Record<string, (args: RenderArgs<Block.Any>) => Out>>
): (message: Timeline.AssistantMessage, options: RenderOptions) => Out | undefined {
  return (message, options) => {
    if (message.block === undefined) return undefined

    const { kind } = message.block
    const block = kit.byKind.get(kind)
    const render = renderers[kind]

    if (block === undefined || render === undefined) return undefined

    const props = Schema.decodeUnknownOption(block.props)(message.block.props)

    if (Option.isNone(props)) return undefined

    const given = message.block.answer

    const answer =
      given === undefined || block.answer === undefined
        ? Option.none()
        : Schema.decodeUnknownOption(Schema.toCodecJson(block.answer))(given)

    return render({
      messageId: message.id,
      text: message.text,
      props: props.value,
      open: message.block.status === "open",
      answer: Option.getOrUndefined(answer),
      respond: (value) => options.respond(Block.answer(block, { messageId: message.id, value }))
    })
  }
}
