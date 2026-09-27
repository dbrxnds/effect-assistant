/**
 * The `BlockKit` module groups the blocks an assistant may put in its messages, and
 * renders them on the client.
 *
 * - Server: `Assistant.make(name, { blocks: kit })` lets `send_user_message`
 *   take a block from the kit. Answers need no server code: they arrive as
 *   `BlockAnswer` inputs.
 * - Client: {@link toClient} maps each kind to a renderer, type-checked so
 *   every kind is covered, and {@link blockStates} says which blocks are still
 *   open.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as AssistantEvent from "./AssistantEvent.ts"
import { AssistantChat } from "./AssistantChat.ts"
import type * as Block from "./Block.ts"
import * as InputId from "./InputId.ts"

/**
 * A catalog of blocks.
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
 * Where a message's block stands.
 *
 * **Details**
 *
 * A block stays open until it's answered: with the block itself, or in words,
 * which the assistant marks by listing the message in a later message's `closes`.
 * Anything else the user sends, like another block's answer or a question
 * about something else, leaves it open. {@link closeStale}, run from a turn,
 * closes the ones the user moved on from, with a `BlocksClosed` event.
 *
 * @category models
 * @since 0.1.0
 */
export interface BlockState {
  readonly open: boolean
  /** Its answer, if the user used it. */
  readonly answer: AssistantEvent.BlockAnswer | undefined
}

/**
 * Returns the block states after one more event.
 *
 * **When to use**
 *
 * Use when a client folds the event stream one entry at a time.
 *
 * @see {@link blockStates} for the states of a whole log
 *
 * @category folding
 * @since 0.1.0
 */
export const nextBlockStates = (
  states: ReadonlyMap<string, BlockState>,
  event: AssistantEvent.AssistantEvent
): ReadonlyMap<string, BlockState> => {
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
 * @category folding
 * @since 0.1.0
 */
export const blockStates = (entries: ReadonlyArray<AssistantEvent.Entry>): ReadonlyMap<string, BlockState> => {
  let states: ReadonlyMap<string, BlockState> = new Map()

  for (const entry of entries) states = nextBlockStates(states, entry.event)

  return states
}

/**
 * Returns the blocks still open after the user typed this many messages
 * without using them: the ones {@link closeStale} closes.
 *
 * @category folding
 * @since 0.1.0
 */
export const staleBlocks = (
  entries: ReadonlyArray<AssistantEvent.Entry>,
  options: { readonly messages: number }
): ReadonlyArray<string> => {
  const open = [...blockStates(entries)].flatMap(([id, state]) => (state.open ? [id] : []))

  return open.filter((id) => {
    const shown = entries.findIndex(({ event }) => Predicate.isTagged(event, "AssistantMessage") && event.id === id)
    const typed = entries.slice(shown + 1).filter(({ event }) => Predicate.isTagged(event, "UserMessage")).length

    return shown !== -1 && typed >= options.messages
  })
}

/**
 * Closes the blocks the user moved on from: still open after this many typed
 * messages. Run it from a turn, before or after its loop; it records a
 * `BlocksClosed` event, so every client folds them closed.
 *
 * **Example** (Closing stale blocks before each turn's loop)
 *
 * ```ts
 * const MyAssistantHandlers = MyAssistant.toLayer((turn) =>
 *   Stream.unwrap(
 *     BlockKit.closeStale({ messages: 3 }).pipe(Effect.as(turn.loop({ model: "claude-sonnet-5", instructions })))
 *   )
 * )
 * ```
 *
 * @category turns
 * @since 0.1.0
 */
export const closeStale = Effect.fn(function* (options: { readonly messages: number }) {
  const chat = yield* AssistantChat
  const stale = staleBlocks(yield* chat.entries, options)

  if (stale.length > 0) yield* chat.append([AssistantEvent.BlocksClosed.make({ messageIds: stale })])
})

/**
 * What a renderer gets for one block.
 *
 * @category models
 * @since 0.1.0
 */
export interface RenderArgs<B> {
  readonly text: string
  readonly props: PropsOf<B>
  /** False once it's answered, with the block or in words: show it read-only then. */
  readonly open: boolean
  /** The user's answer, if they used the block. */
  readonly answer: AnswerOf<B> | undefined
  /** Sends an answer. Only call it while `open`. */
  readonly respond: (answer: AnswerOf<B>) => void
}

/**
 * A renderer for every kind in a kit.
 *
 * @category models
 * @since 0.1.0
 */
export type Renderers<Kit extends BlockKit, Out> = {
  readonly [K in KindOf<Kit["blocks"][number]>]: (args: RenderArgs<BlockOf<Kit, K>>) => Out
}

/**
 * Options for rendering one message's block.
 *
 * @category models
 * @since 0.1.0
 */
export interface RenderOptions {
  /** This message's block state, from {@link blockStates}. Default: open, unanswered. */
  readonly state?: BlockState | undefined
  /** Submits an answer, for example over RPC. */
  readonly respond: (answer: AssistantEvent.BlockAnswer) => void
}

/**
 * Creates a client-side renderer for the blocks in a kit's messages.
 *
 * **Details**
 *
 * The renderer returns `undefined` when a message has no block, or one this
 * client can't show (an unknown kind, or props that don't decode). Show just
 * the text then. `respond` encodes the answer with the block's answer schema
 * and passes a `BlockAnswer` to {@link RenderOptions.respond}. Answers cross
 * the wire in their schema's JSON form, so dates and the like survive.
 *
 * **Example** (Rendering blocks in React)
 *
 * ```tsx
 * import { BlockKit } from "effect-assistant"
 * import type { ReactNode } from "react"
 * import { Blocks } from "./blocks"
 *
 * const render = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
 *   choose_one: ({ props, open, answer, respond }) =>
 *     props.options.map((option) => (
 *       <button key={option} disabled={!open} onClick={() => respond({ choice: option })}>
 *         {answer?.choice === option ? `✓ ${option}` : option}
 *       </button>
 *     )),
 *   confirm: ({ props, open, respond }) => (
 *     <button disabled={!open} onClick={() => respond({ confirmed: true })}>{props.confirmLabel}</button>
 *   )
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export function toClient<Kit extends BlockKit, Out>(
  kit: Kit,
  renderers: Renderers<Kit, Out>
): (message: AssistantEvent.AssistantMessage, options: RenderOptions) => Out | undefined
// The overload above checks that every kind has a renderer; here each one takes any block's arguments.
export function toClient<Out>(
  kit: BlockKit,
  renderers: Readonly<Record<string, (args: RenderArgs<Block.Any>) => Out>>
): (message: AssistantEvent.AssistantMessage, options: RenderOptions) => Out | undefined {
  return (message, options) => {
    if (message.block === undefined) return undefined

    const { kind } = message.block
    const block = kit.byKind.get(kind)
    const render = renderers[kind]

    if (block === undefined || render === undefined) return undefined

    const props = Schema.decodeUnknownOption(block.props)(message.block.props)

    if (Option.isNone(props)) return undefined

    const given = options.state?.answer
    const answerCodec = block.answer === undefined ? undefined : Schema.toCodecJson(block.answer)

    const answer =
      given === undefined || answerCodec === undefined
        ? Option.none()
        : Schema.decodeUnknownOption(answerCodec)(given.value)

    return render({
      text: message.text,
      props: props.value,
      open: options.state?.open ?? true,
      answer: Option.getOrUndefined(answer),
      respond: (value) =>
        options.respond(
          AssistantEvent.BlockAnswer.make({
            // A block takes one answer: the same id every time, so a second click is stored once.
            id: InputId.fromKey(`${message.id}:answer`),
            messageId: message.id,
            kind,
            value: answerCodec === undefined ? value : Schema.encodeUnknownSync(answerCodec)(value)
          })
        )
    })
  }
}
