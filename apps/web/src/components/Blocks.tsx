/**
 * Renderers for what Acme puts in the thread besides text: the blocks on its
 * messages, and the orders and campaigns it asks the user to approve. Using a
 * block sends a `BlockAnswer`; approving or rejecting a call sends an
 * `ApprovalDecision`. Either way the item shows where it stands, and stops
 * taking input once it's answered or decided.
 */
import { Blocks } from "@acme/demo-shared/Blocks"
import type * as AssistantEvent from "effect-assistant/AssistantEvent"
import * as BlockKit from "effect-assistant/BlockKit"
import type * as ChatId from "effect-assistant/ChatId"
import type * as Timeline from "effect-assistant/Timeline"
import * as ToolApproval from "effect-assistant/ToolApproval"
import * as Predicate from "effect/Predicate"
import { createContext, type ReactNode, useContext, useState } from "react"

/** The items of Acme's timeline: messages, and its calls waiting for the user's approval. */
export type AcmeItem = Timeline.Item

/** What the renderers need from the page: the chat, its items, and a way to send what the user does. */
export interface BlockContextValue {
  readonly chatId: ChatId.ChatId | undefined
  readonly byId: ReadonlyMap<string, AcmeItem>
  readonly respond: (input: AssistantEvent.UserInput) => void
}

export const BlockContext = createContext<BlockContextValue>({
  chatId: undefined,
  byId: new Map(),
  respond: () => {}
})

/** A tool's name as people read it: `start_campaign` is "start campaign". */
const toolName = (tool: string) => tool.replaceAll("_", " ")

/** The line for a call to approve. Acme's message above it says what the call does. */
export const approvalTitle = (approval: Timeline.ApprovalItem): string => `Approve: ${toolName(approval.tool)}?`

const decided = {
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired"
}

/**
 * A call Acme asks the user to approve: Approve and Reject while it waits,
 * then where it stands. Acme's message says what it asks; this is the yes or
 * no.
 */
function ApprovalCard(props: { readonly approval: Timeline.ApprovalItem }) {
  const { respond } = useContext(BlockContext)
  const [clicked, setClicked] = useState(false)
  const { approval } = props
  const waiting = approval.status === "pending" && !clicked

  const decide = (input: AssistantEvent.ApprovalDecision) => {
    setClicked(true)
    respond(input)
  }

  return (
    <div className="block-place">
      <div className="block-options">
        {approval.status === "pending" ? (
          <>
            <button type="button" disabled={!waiting} onClick={() => decide(ToolApproval.approve(approval))}>
              Approve
            </button>
            <button type="button" disabled={!waiting} onClick={() => decide(ToolApproval.reject(approval))}>
              Reject
            </button>
          </>
        ) : (
          <button type="button" className="picked" disabled>
            {approval.outcome === "failure" ? "Approved, but it failed" : decided[approval.status]}
          </button>
        )}
      </div>
    </div>
  )
}

function ChooseOne(props: {
  readonly options: ReadonlyArray<string>
  readonly open: boolean
  readonly picked: string | undefined
  readonly onPick: (option: string) => void
}) {
  const [clicked, setClicked] = useState<string | undefined>(undefined)
  const chosen = props.picked ?? clicked

  return (
    <div className="block-options">
      {props.options.map((option) => (
        <button
          key={option}
          type="button"
          className={chosen === option ? "picked" : undefined}
          disabled={!props.open || chosen !== undefined}
          onClick={() => {
            setClicked(option)
            props.onPick(option)
          }}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

function TextInput(props: {
  readonly placeholder: string
  readonly open: boolean
  readonly sent: string | undefined
  readonly onSend: (value: string) => void
}) {
  const [value, setValue] = useState("")
  const [clicked, setClicked] = useState<string | undefined>(undefined)
  const sent = props.sent ?? clicked

  if (sent !== undefined) return <div className="block-input sent">{sent}</div>

  if (!props.open) return null

  const submit = () => {
    const trimmed = value.trim()

    if (!trimmed) return
    setClicked(trimmed)
    props.onSend(trimmed)
  }

  return (
    <form
      className="block-input"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <input value={value} placeholder={props.placeholder} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" disabled={!value.trim()}>
        Send
      </button>
    </form>
  )
}

const render = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
  choose_one: ({ props, open, answer, respond }) => (
    <ChooseOne options={props.options} open={open} picked={answer?.choice} onPick={(choice) => respond({ choice })} />
  ),
  text_input: ({ props, open, answer, respond }) => (
    <TextInput
      placeholder={props.placeholder}
      open={open}
      sent={answer?.value}
      onSend={(value) => respond({ value })}
    />
  )
})

/** The block under an assistant message, or the card of a call to approve, if this app knows it. */
export function MessageBlock(props: { readonly messageId: string }) {
  const { byId, respond } = useContext(BlockContext)
  const item = byId.get(props.messageId)

  if (item === undefined) return null

  if (Predicate.isTagged(item, "ToolApproval")) return <ApprovalCard approval={item} />

  return Predicate.isTagged(item, "AssistantMessage") ? (render(item, { respond }) ?? null) : null
}
