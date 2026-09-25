/**
 * Sending what the user does: typed text, or a block answer.
 */
import { useAtomSet } from "@effect/atom-react"
import * as AssistantEvent from "effect-assistant/AssistantEvent"
import type * as ChatId from "effect-assistant/ChatId"
import * as InputId from "effect-assistant/InputId"
import * as Exit from "effect/Exit"
import * as Predicate from "effect/Predicate"
import { useCallback } from "react"
import * as AcmeRpc from "./AcmeRpc.ts"
import type * as ChatState from "./ChatState.ts"

/**
 * Returns a function that submits an input. Typed text shows at once as a
 * pending message; a block answer shows in its block. On failure the pending
 * message is removed and `onError` runs.
 */
export const useSend = (
  chatId: ChatId.ChatId,
  setPending: (update: (pending: ReadonlyArray<ChatState.ChatMessage>) => ReadonlyArray<ChatState.ChatMessage>) => void,
  onError: (message: string) => void
) => {
  const submit = useAtomSet(AcmeRpc.submit, { mode: "promiseExit" })

  return useCallback(
    async (input: AssistantEvent.ClientInput) => {
      const pending: ChatState.ChatMessage | undefined = Predicate.isTagged(input, "UserMessage")
        ? { id: input.id, role: "user", text: input.text }
        : undefined

      if (pending) setPending((all) => [...all, pending])

      // The first message names the thread, so refresh the list too.
      const exit = await submit({ payload: { chatId, input }, reactivityKeys: AcmeRpc.chatListKeys })

      if (Exit.isFailure(exit)) {
        if (pending) setPending((all) => all.filter((message) => message.id !== pending.id))
        onError("Message didn't send. Try again.")
      }
    },
    [chatId, submit, setPending, onError]
  )
}

/** The text of a composer message, as a `UserMessage`, or nothing if it's blank. */
export const userMessage = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) => {
  const text = content.find((part) => part.type === "text")?.text?.trim() ?? ""

  return text.length === 0 ? undefined : AssistantEvent.UserMessage.make({ id: InputId.make(), text })
}
