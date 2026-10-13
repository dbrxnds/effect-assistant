/**
 * End-to-end smoke test against a running demo (local, preview, or prod), with
 * the real model and the real RPC socket. It sees what the web app sees (the
 * chat's view), so it checks what the user is told. Every chat it creates is
 * deleted at the end, so the thread list stays clean for demos.
 *
 *   pnpm --filter @acme/demo-api smoke [baseUrl]
 *
 * - greeting: a new thread gets a reply.
 * - choice: an unclear product gets options (buttons or text); picking one
 *   works.
 * - interrupt: a second question while the assistant works on the first; both get
 *   answered.
 * - campaign: order with office, audience, and budget up front; start it with
 *   the campaign block's button (`StartCampaign`); the assistant reports going
 *   live and the first results.
 * - products: order tote bags; place it with the order block's button
 *   (`PlaceOrder`); the assistant reports shipping (with tracking) and
 *   delivery.
 * - research: a performance report across campaigns, from the research
 *   specialist, in the background.
 *
 * Scenarios run at the same time, in separate chats.
 */
import { CampaignDraft, OrderDraft } from "@acme/demo-shared/Blocks"
import { AcmeRpcs } from "@acme/demo-shared/Rpc"
import * as AssistantEvent from "effect-assistant/AssistantEvent"
import type * as ChatId from "effect-assistant/ChatId"
import * as ChatView from "effect-assistant/ChatView"
import * as InputId from "effect-assistant/InputId"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Socket from "effect/socket/Socket"

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "")

const layer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(`${base.replace(/^http/, "ws")}/rpc`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerNdjson)
)

/** What the smoke test sees of a chat: its view after each update, as a client folds them. */
type Views = ReadonlyArray<ChatView.View>

const ChoiceProps = Schema.Struct({ options: Schema.Array(Schema.String) })

const latest = (views: Views): ChatView.View => views.at(-1) ?? ChatView.empty

const sent = (view: ChatView.View): ReadonlyArray<ChatView.AssistantMessage> =>
  view.messages.flatMap((message) => (Predicate.isTagged(message, "AssistantMessage") ? [message] : []))

const messages = (views: Views): ReadonlyArray<string> => sent(latest(views)).map((message) => message.text)

const blockMessages = (views: Views, kind: string): ReadonlyArray<ChatView.AssistantMessage> =>
  sent(latest(views)).filter((message) => message.block?.kind === kind)

const failed = (views: Views) => latest(views).failed

const idle = (views: Views) => views.length > 0 && ChatView.isIdle(latest(views))

/** Whether the assistant said something matching `pattern`, and is done. */
const said = (views: Views, pattern: RegExp) => idle(views) && messages(views).some((text) => pattern.test(text))

/** Whether a specialist worked, and the assistant said something after it and is done. */
const reportedBack = (views: Views) => {
  const from = views.findIndex((view) => view.activity.specialists.length > 0)

  return from !== -1 && idle(views) && sent(latest(views)).length > sent(views[from]!).length
}

/** One line per message, for a timeout message. */
const trace = (views: Views) =>
  latest(views)
    .messages.flatMap((message) =>
      Predicate.isTagged(message, "AssistantMessage")
        ? [
            `  acme: ${message.text.slice(0, 120)}${message.block === undefined ? "" : ` [${message.block.kind}: ${message.block.status}]`}`
          ]
        : Predicate.isTagged(message, "UserMessage")
          ? [`  user: ${message.text.slice(0, 120)}`]
          : []
    )
    .join("\n")

const oneLine = (text: string | undefined) => (text ?? "").replaceAll("\n", " ").slice(0, 160)

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(AcmeRpcs)
  const created = yield* Ref.make<ReadonlyArray<ChatId.ChatId>>([])

  const health = yield* Effect.promise(() => fetch(`${base}/health`))

  if (!health.ok) return yield* Effect.fail(`health ${health.status}`)

  const newChat = Effect.gen(function* () {
    const { chatId } = yield* client.CreateChat()
    yield* Ref.update(created, (all) => [...all, chatId])

    return chatId
  })

  /** Leaves no smoke threads behind. */
  const cleanup = Ref.get(created).pipe(
    Effect.flatMap((chats) => Effect.forEach(chats, (chatId) => client.DeleteChat({ chatId }).pipe(Effect.ignore))),
    Effect.ignore
  )

  /** Folds a chat's view until `until` holds for the views so far. */
  const waitFor = (chatId: ChatId.ChatId, label: string, until: (views: Views) => boolean, seconds = 90) => {
    let seen: Views = []

    return client.Subscribe({ chatId }).pipe(
      Stream.scan(
        (): Views => [],
        (views, update) => [...views, ChatView.apply(latest(views), update)]
      ),
      Stream.tap((views) => Effect.sync(() => (seen = views))),
      Stream.takeUntil((views) => until(views) || failed(views)),
      Stream.runLast,
      Effect.map(Option.getOrElse((): Views => [])),
      Effect.timeoutOrElse({
        duration: Duration.seconds(seconds),
        orElse: () => Effect.fail(`${label}: timed out; the chat so far:\n${trace(seen)}`)
      }),
      Effect.filterOrFail(
        (views) => !failed(views),
        (views) => `${label}: a turn failed (the server's log says why); the chat so far:\n${trace(views)}`
      )
    )
  }

  const send = Effect.fn(function* (chatId: ChatId.ChatId, text: string) {
    return yield* client.Submit({ chatId, input: AssistantEvent.UserMessage.make({ id: yield* InputId.make(), text }) })
  })

  /** Uses a block the way the web app does. */
  const answer = (chatId: ChatId.ChatId, message: ChatView.AssistantMessage, value: Record<string, string | boolean>) =>
    client.Submit({
      chatId,
      input: AssistantEvent.BlockAnswer.make({
        id: InputId.fromKey(`${message.id}:answer`),
        messageId: message.id,
        kind: message.block!.kind,
        value
      })
    })

  /** Waits for the order or campaign block, and clicks its button the way the web app does. */
  const place = Effect.fn(function* (chatId: ChatId.ChatId, label: string, kind: "order_draft" | "campaign_draft") {
    const asked = yield* waitFor(
      chatId,
      `${label}: ${kind} block`,
      (es) => blockMessages(es, kind).length > 0 && idle(es),
      150
    )

    const ask = blockMessages(asked, kind)[0]!

    console.log(`     ${label} > ${oneLine(ask.text)} [${kind}]`)

    if (kind === "order_draft") {
      const order = yield* Schema.decodeUnknownEffect(OrderDraft.props)(ask.block!.props).pipe(Effect.orDie)
      yield* client.PlaceOrder({ chatId, messageId: ask.id, order })
    } else {
      const campaign = yield* Schema.decodeUnknownEffect(CampaignDraft.props)(ask.block!.props).pipe(Effect.orDie)
      yield* client.StartCampaign({ chatId, messageId: ask.id, campaign })
    }
  })

  const timed = Effect.fn(function* <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) {
    const start = Date.now()
    const result = yield* effect
    console.log(`ok   ${label} (${((Date.now() - start) / 1000).toFixed(1)}s)`)

    return result
  })

  const greeting = timed(
    "greeting",
    Effect.gen(function* () {
      const chatId = yield* newChat
      yield* send(chatId, "hey! quick hello")
      const entries = yield* waitFor(chatId, "greeting", (es) => messages(es).length >= 1)
      console.log(`     greeting > ${oneLine(messages(entries)[0])}`)
    })
  )

  const choice = timed(
    "choice: options, then a pick",
    Effect.gen(function* () {
      const chatId = yield* newChat
      yield* send(chatId, "I want to order one of the summer campaigns, which ones are there?")
      const shown = yield* waitFor(chatId, "options", (es) => messages(es).length > 0 && idle(es))
      // Buttons or a list in text: both are fine. Pick the sale either way.
      const ask = blockMessages(shown, "choose_one")[0]

      if (ask === undefined) {
        yield* send(chatId, "The Summer Sale")
      } else {
        const { options } = yield* Schema.decodeUnknownEffect(ChoiceProps)(ask.block!.props).pipe(Effect.orDie)
        yield* answer(chatId, ask, { choice: options.find((option) => /sale/i.test(option)) ?? options[0]! })
      }

      const entries = yield* waitFor(chatId, "after choice", (es) => messages(es).length > 1 && idle(es))
      console.log(`     choice > ${oneLine(messages(entries).at(-1))}`)
    })
  )

  const interrupt = timed(
    "interrupt mid-turn",
    Effect.gen(function* () {
      const chatId = yield* newChat
      yield* send(chatId, "What did the Amsterdam office order recently?")
      // Working on it: the second question arrives while the first turn runs.
      yield* waitFor(chatId, "working", (views) => latest(views).activity.working)
      yield* Effect.sleep("1500 millis")
      yield* send(chatId, "Also: what's the address of the London office?")

      const entries = yield* waitFor(
        chatId,
        "both answered",
        (es) => messages(es).join(" ").toLowerCase().includes("london") && idle(es)
      )

      console.log(`     interrupt > ${oneLine(messages(entries).at(-1))}`)
    })
  )

  const campaign = timed(
    "campaign: started from its block, live, first results",
    Effect.gen(function* () {
      const chatId = yield* newChat
      yield* send(
        chatId,
        "Order the Summer Campaign for the Amsterdam office, for parents in Austin planning trips, budget $4,000."
      )

      yield* place(chatId, "campaign", "campaign_draft")

      const done = yield* waitFor(chatId, "first results", (views) => said(views, /conversion|clicks/i), 240)

      console.log(`     campaign > ${oneLine(messages(done).at(-1))}`)
    })
  )

  const products = timed(
    "products: placed from its block, shipped, delivered",
    Effect.gen(function* () {
      const chatId = yield* newChat
      yield* send(chatId, "Please order 300 cotton tote bags for the Berlin office.")
      yield* place(chatId, "products", "order_draft")

      // The tracking number is only in the workflow's shipped step: the assistant shared it.
      const shipped = yield* waitFor(chatId, "shipped, with tracking", (views) => said(views, /1Z/), 240)
      const before = messages(shipped).length

      const delivered = yield* waitFor(
        chatId,
        "delivered",
        (views) =>
          idle(views) &&
          messages(views)
            .slice(before)
            .some((text) => /deliver/i.test(text)),
        240
      )

      console.log(`     products > ${oneLine(messages(delivered).at(-1))}`)
    })
  )

  const research = timed(
    "research: a report in the background",
    Effect.gen(function* () {
      const chatId = yield* newChat
      yield* send(
        chatId,
        "Have research put together a report on how our campaigns performed this year, ranked by cost per conversion, with a recommendation for Q4."
      )
      const entries = yield* waitFor(chatId, "report", reportedBack, 300)
      console.log(`     research > ${oneLine(messages(entries).at(-1))}`)
    })
  )

  yield* Effect.all([greeting, choice, interrupt, campaign, products, research], {
    concurrency: "unbounded",
    discard: true
  }).pipe(Effect.ensuring(cleanup))
})

program.pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise).then(
  () => {
    console.log("smoke passed")
    process.exit(0)
  },
  (error) => {
    console.error("smoke FAILED:", String(error))
    process.exit(1)
  }
)
