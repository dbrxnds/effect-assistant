import { createFileRoute } from "@tanstack/react-router"
import { AcmeChatPage } from "~/components/AcmeChatPage.tsx"
import * as ChatRoute from "~/lib/ChatRoute.ts"

export const Route = createFileRoute("/chats/$chatId")({
  component: AcmeChatPage,
  beforeLoad: ({ params }) => {
    const chatId = ChatRoute.chatIdFromParam(params.chatId)

    if (chatId === undefined) {
      throw new Error("invalid chat id")
    }

    return { chatId }
  }
})
