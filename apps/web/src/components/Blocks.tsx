/**
 * Renderers for the blocks Acme can put in a message. Answering sends a
 * `BlockAnswer`; once answered, a block shows the answer and stops taking input.
 */
import { Blocks } from "@acme/demo-shared/Blocks"
import type * as AssistantEvent from "effect-assistant/AssistantEvent"
import * as BlockKit from "effect-assistant/BlockKit"
import { createContext, type ReactNode, useContext, useState } from "react"
import type * as ChatState from "~/lib/ChatState.ts"

/** What block renderers need from the page: the messages, their block states, and a way to answer. */
export interface BlockContextValue {
  readonly byId: ReadonlyMap<string, ChatState.ChatMessage>
  readonly states: ReadonlyMap<string, BlockKit.BlockState>
  readonly respond: (answer: AssistantEvent.BlockAnswer) => void
}

export const BlockContext = createContext<BlockContextValue>({ byId: new Map(), states: new Map(), respond: () => {} })

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
  confirm: ({ props, open, answer, respond }) => (
    <ChooseOne
      options={[props.confirmLabel, props.denyLabel]}
      open={open}
      picked={answer === undefined ? undefined : answer.confirmed ? props.confirmLabel : props.denyLabel}
      onPick={(label) => respond({ confirmed: label === props.confirmLabel })}
    />
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
  const { byId, states, respond } = useContext(BlockContext)
  const message = byId.get(props.messageId)

  if (message?.withBlock === undefined) return null

  return render(message.withBlock, { state: states.get(props.messageId), respond }) ?? null
}
