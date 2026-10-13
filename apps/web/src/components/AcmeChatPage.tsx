import { emptyThreadPrompt, suggestions } from "@acme/demo-shared/ChatList"
import { demoChatId } from "@acme/demo-shared/Ids"
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useExternalStoreRuntime
} from "@assistant-ui/react"
import { useAtom, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import * as AssistantEvent from "effect-assistant/AssistantEvent"
import type * as ChatId from "effect-assistant/ChatId"
import type * as Timeline from "effect-assistant/Timeline"
import * as InputId from "effect-assistant/InputId"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Predicate from "effect/Predicate"
import { useCallback, useMemo, useState } from "react"
import * as AcmeRpc from "~/lib/AcmeRpc.ts"
import * as ChatRoute from "~/lib/ChatRoute.ts"
import * as ChatState from "~/lib/ChatState.ts"
import { userMessage, useSend } from "~/lib/useSend.ts"
import { Route } from "~/routes/chats/$chatId.tsx"
import "../chat.css"
import { BlockContext, type BlockContextValue } from "./Blocks.tsx"
import { Message, Typing } from "./Message.tsx"
import { ThreadList } from "./ThreadList.tsx"

const toThreadMessage = (message: Timeline.Item): ThreadMessageLike =>
  Predicate.isTagged(message, "UserMessage")
    ? { id: message.id, role: "user", content: message.text }
    : { id: message.id, role: "assistant", content: message.text, status: { type: "complete", reason: "stop" } }

const messageComponents = { Message }

/** A chat: the thread list, the messages, and the composer. */
export function AcmeChatPage() {
  // One RPC socket for the tab, shared by every chat and the thread list.
  useAtomMount(AcmeRpc.AcmeRpc.runtime)

  const navigate = useNavigate()
  const { chatId } = Route.useRouteContext()
  const server = AcmeRpc.chatSession(useAtomValue(AcmeRpc.chatSessionAtom(chatId)))
  const [pending, setPending] = useAtom(ChatState.pendingSends(chatId))
  const state = useMemo(() => ChatState.withPendingSends(server, pending), [server, pending])
  const chats = AcmeRpc.chatList(useAtomValue(AcmeRpc.chatListAtom))
  const live = useAtomValue(AcmeRpc.connectionAtom) === "open"
  const createChat = useAtomSet(AcmeRpc.createChat, { mode: "promiseExit" })
  const deleteChat = useAtomSet(AcmeRpc.deleteChat, { mode: "promiseExit" })
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [drawer, setDrawer] = useState(false)

  const send = useSend(chatId, setPending, setNotice)

  const onNew = useCallback(
    async (message: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }) => {
      const input = userMessage(message.content)

      if (input) await send(input)
    },
    [send]
  )

  const blocks = useMemo<BlockContextValue>(
    () => ({
      chatId,
      byId: new Map(state.items.map((item) => [item.id, item])),
      respond: (answer) => void send(answer)
    }),
    [chatId, state.items, send]
  )

  const openChat = (next: ChatId.ChatId) => {
    setDrawer(false)
    void navigate({ to: ChatRoute.path(next) })
  }

  const onCreate = async () => {
    const exit = await createChat({ payload: undefined, reactivityKeys: AcmeRpc.chatListKeys })

    if (Exit.isFailure(exit)) return setNotice("Couldn't create a thread.")

    setNotice(undefined)
    openChat(exit.value.chatId)
  }

  /** Shift-click skips the confirmation. */
  const onDelete = async (target: ChatId.ChatId, skipConfirm: boolean) => {
    const title = chats.find((chat) => chat.chatId === target)?.title ?? "this thread"

    if (!skipConfirm && !window.confirm(`Delete "${title}"? This can't be undone.`)) return

    const exit = await deleteChat({ payload: { chatId: target }, reactivityKeys: AcmeRpc.chatListKeys })

    if (Exit.isFailure(exit)) return setNotice("Couldn't delete the thread.")

    setNotice(undefined)

    if (target === chatId) openChat(demoChatId)
  }

  const runtime = useExternalStoreRuntime<Timeline.Item>({
    messages: [...state.items],
    isRunning: false,
    convertMessage: toThreadMessage,
    onNew
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <BlockContext.Provider value={blocks}>
        <div className="shell">
          {drawer ? (
            <button
              type="button"
              className="sidebar-backdrop"
              aria-label="Close threads"
              onClick={() => setDrawer(false)}
            />
          ) : null}
          <ThreadList
            chats={chats}
            notice={notice}
            activeChatId={chatId}
            open={drawer}
            onPickThread={openChat}
            onCreate={() => void onCreate()}
            onDelete={(target, skipConfirm) => void onDelete(target, skipConfirm)}
            onClose={() => setDrawer(false)}
          />
          <div className="room">
            <header className="room-header">
              <button type="button" className="menu" onClick={() => setDrawer(true)}>
                Threads
              </button>
              <div className="mark" aria-hidden="true">
                M
              </div>
              <div className="room-title">
                <strong>Acme</strong>
                <span>{chats.find((chat) => chat.chatId === chatId)?.title ?? "Thread"}</span>
              </div>
              <div className={live ? "live on" : "live"}>
                <i />
                {live ? "Live" : "Reconnecting"}
              </div>
            </header>
            <ThreadPrimitive.Root className="thread">
              <ThreadPrimitive.Viewport className="viewport" autoScroll>
                <ThreadPrimitive.Empty>
                  <div className="empty">
                    <strong>Acme</strong>
                    {emptyThreadPrompt}
                    <div className="suggestions">
                      {suggestions.map((text) => (
                        <button
                          key={text}
                          type="button"
                          onClick={() =>
                            void send(AssistantEvent.UserMessage.make({ id: Effect.runSync(InputId.make()), text }))
                          }
                        >
                          {text}
                        </button>
                      ))}
                    </div>
                  </div>
                </ThreadPrimitive.Empty>
                <ThreadPrimitive.Messages components={messageComponents} />
                {state.working ? <Typing /> : null}
              </ThreadPrimitive.Viewport>
              {state.failed ? <p className="notice">Something went wrong on my side. Try again.</p> : null}
              <div className="composer-wrap">
                <ComposerPrimitive.Root className="composer">
                  <ComposerPrimitive.Input placeholder="Message" rows={1} autoFocus />
                  <ComposerPrimitive.Send asChild>
                    <button type="submit" className="send">
                      Send
                    </button>
                  </ComposerPrimitive.Send>
                </ComposerPrimitive.Root>
              </div>
            </ThreadPrimitive.Root>
          </div>
        </div>
      </BlockContext.Provider>
    </AssistantRuntimeProvider>
  )
}
