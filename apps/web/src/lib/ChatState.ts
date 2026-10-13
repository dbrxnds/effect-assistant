/**
 * A chat as the thread shows it: its timeline (`Timeline`), folded from the
 * `Subscribe` stream, with this tab's sends the server hasn't echoed yet.
 *
 * The server sends only what the user sees, so nothing here picks through
 * the assistant's work. Every Subscribe replays the chat from the start;
 * applying a change again changes nothing.
 */
import type * as ChatId from "effect-assistant/ChatId"
import * as Timeline from "effect-assistant/Timeline"
import * as Atom from "effect/reactivity/Atom"

/** A chat's timeline, and whether anything works in it: the assistant's turn, or a specialist. */
export type ChatState = Timeline.Timeline & { readonly working: boolean }

const withWorking = (timeline: Timeline.Timeline): ChatState => ({ ...timeline, working: !Timeline.isIdle(timeline) })

/** A chat before its first change. */
export const initial: ChatState = withWorking(Timeline.empty)

/** A chat after one more change. */
export const apply = (state: ChatState, change: Timeline.Change): ChatState =>
  withWorking(Timeline.apply(state, change))

/** Messages this tab sent that the server hasn't echoed yet. */
export const pendingSends = Atom.family((_chatId: ChatId.ChatId) => Atom.make<ReadonlyArray<Timeline.UserMessage>>([]))

/** Server messages plus this tab's unconfirmed sends, which the assistant is about to work on. */
export const withPendingSends = (state: ChatState, pending: ReadonlyArray<Timeline.UserMessage>): ChatState => {
  const unconfirmed = pending.filter((p) => !state.items.some((item) => item.id === p.id))

  return unconfirmed.length === 0 ? state : { ...state, working: true, items: [...state.items, ...unconfirmed] }
}
