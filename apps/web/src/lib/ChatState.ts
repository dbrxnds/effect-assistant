/**
 * A chat as the thread shows it: its view (`ChatView`), folded from the
 * `Subscribe` stream, with this tab's sends the server hasn't echoed yet.
 *
 * The server sends only what the user sees, so nothing here picks through
 * the assistant's work. Every Subscribe replays the chat from the start;
 * applying an update again changes nothing.
 */
import type * as ChatId from "effect-assistant/ChatId"
import * as ChatView from "effect-assistant/ChatView"
import * as Atom from "effect/unstable/reactivity/Atom"

/** A chat's view, and whether anything works in it: the assistant's turn, or a specialist. */
export type ChatState = ChatView.View & { readonly working: boolean }

const withWorking = (view: ChatView.View): ChatState => ({ ...view, working: !ChatView.isIdle(view) })

/** A chat before its first update. */
export const initial: ChatState = withWorking(ChatView.empty)

/** A chat after one more update. */
export const apply = (state: ChatState, update: ChatView.Update): ChatState =>
  withWorking(ChatView.apply(state, update))

/** Messages this tab sent that the server hasn't echoed yet. */
export const pendingSends = Atom.family((_chatId: ChatId.ChatId) => Atom.make<ReadonlyArray<ChatView.UserMessage>>([]))

/** Server messages plus this tab's unconfirmed sends, which the assistant is about to work on. */
export const withPendingSends = (state: ChatState, pending: ReadonlyArray<ChatView.UserMessage>): ChatState => {
  const unconfirmed = pending.filter((p) => !state.messages.some((m) => m.id === p.id))

  return unconfirmed.length === 0 ? state : { ...state, working: true, messages: [...state.messages, ...unconfirmed] }
}
