import { useMessagePartText } from "@assistant-ui/react"
import ReactMarkdown from "react-markdown"

/** A message part's text, rendered as markdown. */
export function MarkdownText() {
  const { text } = useMessagePartText()

  return (
    <div className="md">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  )
}
