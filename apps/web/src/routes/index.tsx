import { demoChatId } from "@acme/demo-shared/Ids"
import { createFileRoute, redirect } from "@tanstack/react-router"
import * as ChatRoute from "~/lib/ChatRoute.ts"

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: ChatRoute.path(demoChatId) })
  }
})
