/**
 * Renderers for the blocks Acme can put in a message. Each message's view
 * says where its block stands. Answering sends a `BlockAnswer`; once
 * answered, a block shows the answer and stops taking input.
 */
import { Blocks } from "@acme/demo-shared/Blocks"
import type * as AssistantEvent from "effect-assistant/AssistantEvent"
import * as BlockKit from "effect-assistant/BlockKit"
import type * as ChatView from "effect-assistant/ChatView"
import * as Decision from "effect-assistant/Decision"
import * as Predicate from "effect/Predicate"
import { createContext, type ReactNode, useContext, useState } from "react"

/** What block renderers need from the page: the messages, and a way to answer. */
export interface BlockContextValue {
  readonly byId: ReadonlyMap<string, ChatView.Message>
  readonly respond: (answer: AssistantEvent.BlockAnswer) => void
}

export const BlockContext = createContext<BlockContextValue>({
  byId: new Map(),
  respond: () => {}
})

/** A call's params, one per line: what the user decides on. */
function Preview(props: { readonly value: unknown }) {
  if (!Predicate.isObject(props.value) || Array.isArray(props.value)) return null

  return (
    <dl className="block-preview">
      {Object.entries(props.value).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Approve / decline for the decisions a message asks for, with what each one is about. */
function DecisionBlock(props: {
  readonly block: Decision.Props
  readonly decisions: ReadonlyArray<ChatView.Decision>
  readonly open: boolean
  readonly respond: (answer: Decision.Answer) => void
}) {
  const [clicked, setClicked] = useState<AssistantEvent.DecisionOutcome | undefined>(undefined)
  const decided = props.decisions.find((decision) => decision.outcome !== undefined)?.outcome ?? clicked
  const approve = props.block.approveLabel ?? "Approve"
  const decline = props.block.declineLabel ?? "Decline"

  return (
    <div className="block-decision">
      {props.decisions.map((decision) => (
        <Preview key={decision.id} value={decision.params} />
      ))}
      <ChooseOne
        options={[approve, decline]}
        open={props.open && decided === undefined}
        picked={decided === undefined ? undefined : decided === "approved" ? approve : decline}
        onPick={(label) => {
          const outcome = label === approve ? "approved" : "declined"

          setClicked(outcome)
          props.respond(Decision.answerAll(props.block, outcome))
        }}
      />
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
  decision: ({ props, decisions, open, respond }) => (
    <DecisionBlock block={props} decisions={decisions} open={open} respond={respond} />
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

/** The block under an assistant message, if it has one this app knows. */
export function MessageBlock(props: { readonly messageId: string }) {
  const { byId, respond } = useContext(BlockContext)
  const message = byId.get(props.messageId)

  if (message === undefined || !Predicate.isTagged(message, "AssistantMessage")) return null

  return render(message, { respond }) ?? null
}
