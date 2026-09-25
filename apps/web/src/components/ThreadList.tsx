import { type ChatList, seededChat } from "@acme/demo-shared/ChatList"
import type * as ChatId from "effect-assistant/ChatId"

/** The sidebar: every thread, a button for a new one, and delete buttons. */
export function ThreadList(props: {
  readonly chats: ChatList
  readonly notice?: string | undefined
  readonly activeChatId: ChatId.ChatId
  readonly open: boolean
  readonly onPickThread: (chatId: ChatId.ChatId) => void
  readonly onCreate: () => void
  readonly onDelete: (chatId: ChatId.ChatId, skipConfirm: boolean) => void
  readonly onClose: () => void
}) {
  return (
    <aside className={props.open ? "sidebar open" : "sidebar"} aria-label="Threads">
      <div className="sidebar-head">
        <strong>Threads</strong>
        <button type="button" className="text-btn" onClick={props.onCreate}>
          New thread
        </button>
        <button type="button" className="text-btn sidebar-close" onClick={props.onClose}>
          Close
        </button>
      </div>
      <div className="chat-list" aria-label="Threads">
        {props.chats.map((thread) => (
          <div
            key={thread.chatId}
            className={thread.chatId === props.activeChatId ? "chat-row on" : "chat-row"}
          >
            <button
              type="button"
              className="chat-pick"
              aria-current={thread.chatId === props.activeChatId ? "true" : undefined}
              onClick={() => props.onPickThread(thread.chatId)}
            >
              {thread.title}
            </button>
            {thread.chatId === seededChat.chatId ? null : (
              <button
                type="button"
                className="chat-delete"
                aria-label={`Delete thread ${thread.title}`}
                title="Delete thread (shift-click to skip confirming)"
                onClick={(event) => props.onDelete(thread.chatId, event.shiftKey)}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {props.notice ? <p className="sidebar-note">{props.notice}</p> : null}
    </aside>
  )
}
