import { MessagePrimitive, useAuiState } from "@assistant-ui/react"
import { MessageBlock } from "./Blocks.tsx"
import { MarkdownText } from "./MarkdownText.tsx"

function Avatar() {
  return (
    <div className="avatar" aria-hidden="true">
      M
    </div>
  )
}

/** One message in the thread; Acme's messages show their block under the text. */
export function Message() {
  const user = useAuiState((s) => s.message.role) === "user"
  const id = useAuiState((s) => s.message.id)

  return (
    <div className={user ? "row user" : "row assistant"}>
      {user ? null : <Avatar />}
      <div className="stack">
        <div className="bubble">
          <MessagePrimitive.Root>
            <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
          </MessagePrimitive.Root>
        </div>
        {user ? null : <MessageBlock messageId={id} />}
      </div>
    </div>
  )
}

/** The message Acme is writing, as it writes it. */
export function Composing({ text }: { readonly text: string }) {
  return (
    <div className="row assistant">
      <Avatar />
      <div className="stack">
        <div className="bubble streaming" aria-live="polite">
          {text}
        </div>
      </div>
    </div>
  )
}

/** Shown while Acme works on something the user sent, and writes a message before its text arrives. */
export function Typing() {
  return (
    <div className="row assistant">
      <Avatar />
      <div className="typing" aria-label="Acme is working">
        <i />
        <i />
        <i />
      </div>
    </div>
  )
}
