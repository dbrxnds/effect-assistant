/**
 * Renderers for the blocks Acme can put in a message. Each message in the timeline
 * says where its block stands. Answering sends a `BlockAnswer`; once
 * answered, a block shows the answer and stops taking input. An order or a
 * campaign has no answer: its button places it through the API, which tells
 * the chat.
 */
import { useAtomSet } from "@effect/atom-react"
import { Blocks, type CampaignDraft, type OrderDraft } from "@acme/demo-shared/Blocks"
import { OrderRefused } from "@acme/demo-shared/Rpc"
import type * as AssistantEvent from "effect-assistant/AssistantEvent"
import * as BlockKit from "effect-assistant/BlockKit"
import type * as ChatId from "effect-assistant/ChatId"
import type * as Timeline from "effect-assistant/Timeline"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import { createContext, type ReactNode, useContext, useState } from "react"
import * as AcmeRpc from "~/lib/AcmeRpc.ts"

/** What block renderers need from the page: the chat, its messages, and a way to answer. */
export interface BlockContextValue {
  readonly chatId: ChatId.ChatId | undefined
  readonly byId: ReadonlyMap<string, Timeline.Item>
  readonly respond: (answer: AssistantEvent.BlockAnswer) => void
}

export const BlockContext = createContext<BlockContextValue>({
  chatId: undefined,
  byId: new Map(),
  respond: () => {}
})

/** What a block shows, one per line: what the user places. */
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

type Placed = Exit.Exit<{ readonly reference: string }, { readonly _tag: string }>

/** Why the API refused, or a generic line when it didn't say. */
const refusal = (exit: Placed) =>
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => "Couldn't place it. Try again.",
    onSome: (error) => (error instanceof OrderRefused ? error.message : "Couldn't place it. Try again.")
  })

/** The message whose block is rendering: the API places one order per block. */

/**
 * What the block shows, and a button that places it through the API. The
 * API tells the chat, and Acme follows up with the reference.
 */
function PlaceBlock(props: {
  readonly shows: object
  readonly label: string
  readonly open: boolean
  readonly place: () => Promise<Placed>
}) {
  const [busy, setBusy] = useState(false)
  const [placed, setPlaced] = useState<string | undefined>(undefined)
  const [refused, setRefused] = useState<string | undefined>(undefined)

  const onClick = async () => {
    setBusy(true)
    setRefused(undefined)

    const exit = await props.place()

    setBusy(false)

    if (Exit.isSuccess(exit)) setPlaced(exit.value.reference)
    else setRefused(refusal(exit))
  }

  return (
    <div className="block-place">
      <Preview value={props.shows} />
      <div className="block-options">
        <button
          type="button"
          className={placed === undefined ? undefined : "picked"}
          disabled={!props.open || busy || placed !== undefined}
          onClick={() => void onClick()}
        >
          {placed === undefined ? props.label : `Placed: ${placed}`}
        </button>
      </div>
      {refused === undefined ? null : <p className="block-refused">{refused}</p>}
    </div>
  )
}

function OrderBlock(props: {
  readonly order: typeof OrderDraft.props.Type
  readonly messageId: string
  readonly open: boolean
}) {
  const { chatId } = useContext(BlockContext)
  const placeOrder = useAtomSet(AcmeRpc.placeOrder, { mode: "promiseExit" })

  if (chatId === undefined) return null

  return (
    <PlaceBlock
      shows={props.order}
      label="Place order"
      open={props.open}
      place={() => placeOrder({ payload: { chatId, messageId: props.messageId, order: props.order } })}
    />
  )
}

function CampaignBlock(props: {
  readonly campaign: typeof CampaignDraft.props.Type
  readonly messageId: string
  readonly open: boolean
}) {
  const { chatId } = useContext(BlockContext)
  const startCampaign = useAtomSet(AcmeRpc.startCampaign, { mode: "promiseExit" })

  if (chatId === undefined) return null

  return (
    <PlaceBlock
      shows={props.campaign}
      label="Start campaign"
      open={props.open}
      place={() => startCampaign({ payload: { chatId, messageId: props.messageId, campaign: props.campaign } })}
    />
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
  order_draft: ({ messageId, props, open }) => <OrderBlock order={props} messageId={messageId} open={open} />,
  campaign_draft: ({ messageId, props, open }) => <CampaignBlock campaign={props} messageId={messageId} open={open} />,
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
