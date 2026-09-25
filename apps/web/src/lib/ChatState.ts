/**
 * Chat state folded from the assistant's event stream.
 *
 * Every Subscribe replays the chat from the start, so entries are applied once
 * by `seq`. "Working" is `AssistantActivity`: a turn or a specialist run is
 * open in the log.
 */
import * as AssistantActivity from "effect-assistant/AssistantActivity"
import type * as AssistantEvent from "effect-assistant/AssistantEvent"
import * as BlockKit from "effect-assistant/BlockKit"
import type * as ChatId from "effect-assistant/ChatId"
import * as Match from "effect/Match"
import * as Atom from "effect/unstable/reactivity/Atom"

/** A message as the thread shows it. */
export type ChatMessage = {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly text: string
  /** The assistant's message, when it has a block. */
  readonly withBlock?: AssistantEvent.AssistantMessage
}

/** A chat, folded from its events. */
export type ChatState = {
  readonly chatId: ChatId.ChatId
  readonly lastSeq: number
  readonly messages: ReadonlyArray<ChatMessage>
  /** Block states by message id. */
  readonly blocks: ReadonlyMap<string, BlockKit.BlockState>
  /** What is working: the assistant's turn, specialist runs. */
  readonly activity: AssistantActivity.Activity
  readonly working: boolean
  /** Set when the last turn failed, cleared by the next message. */
  readonly failed: boolean
}

/** A chat before any event. */
export const initial = (chatId: ChatId.ChatId): ChatState => ({
  chatId,
  lastSeq: 0,
  messages: [],
  blocks: new Map(),
  activity: AssistantActivity.empty,
  working: false,
  failed: false
})

const assistantMessage = (message: AssistantEvent.AssistantMessage): ChatMessage =>
  message.block === undefined
    ? { id: message.id, role: "assistant", text: message.text }
    : { id: message.id, role: "assistant", text: message.text, withBlock: message }

/** A chat after one more entry. Entries at or below `lastSeq` are ignored. */
export const apply = (state: ChatState, entry: AssistantEvent.Entry): ChatState => {
  if (entry.seq <= state.lastSeq) return state

  const activity = AssistantActivity.apply(state.activity, entry)

  const next: ChatState = {
    ...state,
    lastSeq: entry.seq,
    blocks: BlockKit.nextBlockStates(state.blocks, entry.event),
    activity,
    working: AssistantActivity.isWorking(activity)
  }

  return Match.value(entry.event).pipe(
    Match.tag("UserMessage", (message): ChatState => ({
      ...next,
      failed: false,
      messages: [...next.messages, { id: message.id, role: "user", text: message.text }]
    })),
    // Shown in its block, not as a message.
    Match.tag("BlockAnswer", (): ChatState => ({ ...next, failed: false })),
    Match.tag("AssistantMessage", (message): ChatState => ({
      ...next,
      failed: false,
      messages: [...next.messages, assistantMessage(message)]
    })),
    Match.tag("TurnFailed", (): ChatState => ({ ...next, failed: true })),
    Match.orElse(() => next)
  )
}

/** Messages this tab sent that the server hasn't echoed yet. */
export const pendingSends = Atom.family((_chatId: ChatId.ChatId) => Atom.make<ReadonlyArray<ChatMessage>>([]))

/** Server messages plus this tab's unconfirmed sends. */
export const withPendingSends = (
  state: ChatState,
  pending: ReadonlyArray<ChatMessage>
): ChatState => {
  const unconfirmed = pending.filter((p) => !state.messages.some((m) => m.id === p.id))

  return unconfirmed.length === 0
    ? state
    : { ...state, working: true, messages: [...state.messages, ...unconfirmed] }
}
