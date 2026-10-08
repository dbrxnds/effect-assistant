/**
 * The `BlockKit` module groups the blocks an assistant may put in its messages, and
 * renders them on the client.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { AssistantChat } from "./AssistantChat.ts"
import * as AssistantEvent from "./AssistantEvent.ts"
import type * as Block from "./Block.ts"
import type * as ChatView from "./ChatView.ts"
import * as Decision from "./Decision.ts"
import * as InputId from "./InputId.ts"

/** A catalog of blocks. */
export interface BlockKit<Blocks extends Block.Any = Block.Any> {
  readonly blocks: ReadonlyArray<Blocks>
  readonly byKind: ReadonlyMap<string, Blocks>
}

/** Creates a kit from blocks. */
export const make = <const Blocks extends ReadonlyArray<Block.Any>>(blocks: Blocks): BlockKit<Blocks[number]> => ({
  blocks,
  byKind: new Map(blocks.map((block) => [block.kind, block]))
})

type KindOf<B> = B extends { readonly kind: infer K extends string } ? K : never

type BlockOf<Kit extends BlockKit, K> = Extract<Kit["blocks"][number], { readonly kind: K }>

type PropsOf<B> = B extends { readonly props: Schema.Top } ? B["props"]["Type"] : never

type AnswerOf<B> = B extends { readonly answer: infer A } ? (A extends Schema.Top ? A["Type"] : never) : never

/** Where a message's block stands. */
export interface BlockState {
  readonly open: boolean
  /** Its answer, if the user used it. */
  readonly answer: AssistantEvent.BlockAnswer | undefined
}

/** Returns the block states after one more event. */
export const nextBlockStates = (
  states: ReadonlyMap<string, BlockState>,
  event: { readonly _tag: string }
): ReadonlyMap<string, BlockState> => {
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

/** Returns the state of every message's block, by message id. */
export const blockStates = (entries: ReadonlyArray<AssistantEvent.AnyEntry>): ReadonlyMap<string, BlockState> => {
  let states: ReadonlyMap<string, BlockState> = new Map()

  for (const entry of entries) states = nextBlockStates(states, entry.event)

  return states
}

/**
 * Returns the blocks still open after the user typed this many messages
 * without using them: the ones {@link closeStale} closes. Decision blocks
 * never go stale: work waits on them, and closing one would leave it waiting.
 */
export const staleBlocks = (
  entries: ReadonlyArray<AssistantEvent.AnyEntry>,
  options: { readonly messages: number }
): ReadonlyArray<string> => {
  const open = [...blockStates(entries)].flatMap(([id, state]) => (state.open ? [id] : []))

  return open.filter((id) => {
    const shown = entries.findIndex(
      ({ event }) =>
        AssistantEvent.isLibraryEvent(event) && Predicate.isTagged(event, "AssistantMessage") && event.id === id
    )

    const message = entries[shown]?.event

    if (
      message === undefined ||
      (AssistantEvent.isLibraryEvent(message) &&
        Predicate.isTagged(message, "AssistantMessage") &&
        message.block?.kind === Decision.kind)
    )
      return false

    const typed = entries.slice(shown + 1).filter(({ event }) => Predicate.isTagged(event, "UserMessage")).length

    return typed >= options.messages
  })
}

/**
 * Closes the blocks the user moved on from: still open after this many typed
 * messages. Run it from a turn, before or after its loop; it records a
 * `BlocksClosed` event, so every client folds them closed.
 */
export const closeStale = Effect.fn(function* (options: { readonly messages: number }) {
  const chat = yield* AssistantChat
  const stale = staleBlocks(yield* chat.entries, options)

  if (stale.length > 0) yield* chat.append([AssistantEvent.BlocksClosed.make({ messageIds: stale })])
})

/** What a renderer gets for one block. */
export interface RenderArgs<B> {
  readonly text: string
  readonly props: PropsOf<B>
  /** False once it's answered, with the block or in words: show it read-only then. */
  readonly open: boolean
  /** The user's answer, if they used the block. */
  readonly answer: AnswerOf<B> | undefined
  /**
   * For the decision block: what each decision is about (its preview), and how it was decided. Empty otherwise.
   */
  readonly decisions: ReadonlyArray<ChatView.Decision>
  /** Sends an answer. Only call it while `open`. */
  readonly respond: (answer: AnswerOf<B>) => void
}

/** A renderer for every kind in a kit. */
export type Renderers<Kit extends BlockKit, Out> = {
  readonly [K in KindOf<Kit["blocks"][number]>]: (args: RenderArgs<BlockOf<Kit, K>>) => Out
}

/** Options for rendering one message's block. */
export interface RenderOptions {
  /** Submits an answer, for example over RPC. */
  readonly respond: (answer: AssistantEvent.BlockAnswer) => void
}

/**
 * Creates a client-side renderer for the blocks on a chat view's messages
 * (`ChatView.AssistantMessage`).
 */
export function toClient<Kit extends BlockKit, Out>(
  kit: Kit,
  renderers: Renderers<Kit, Out>
): (message: ChatView.AssistantMessage, options: RenderOptions) => Out | undefined
// The overload above checks that every kind has a renderer; here each one takes any block's arguments.
export function toClient<Out>(
  kit: BlockKit,
  renderers: Readonly<Record<string, (args: RenderArgs<Block.Any>) => Out>>
): (message: ChatView.AssistantMessage, options: RenderOptions) => Out | undefined {
  return (message, options) => {
    if (message.block === undefined) return undefined

    const { kind } = message.block
    const block = kit.byKind.get(kind)
    const render = renderers[kind]

    if (block === undefined || render === undefined) return undefined

    const props = Schema.decodeUnknownOption(block.props)(message.block.props)

    if (Option.isNone(props)) return undefined

    const given = message.block.answer
    const answerCodec = block.answer === undefined ? undefined : Schema.toCodecJson(block.answer)

    const answer =
      given === undefined || answerCodec === undefined ? Option.none() : Schema.decodeUnknownOption(answerCodec)(given)

    return render({
      text: message.text,
      props: props.value,
      open: message.block.status === "open",
      answer: Option.getOrUndefined(answer),
      decisions: message.block.decisions ?? [],
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
