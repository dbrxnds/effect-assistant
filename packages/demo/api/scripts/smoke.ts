/**
 * End-to-end smoke test against a running demo (local, preview, or prod), with
 * the real model and the real RPC socket. Every chat it creates is deleted at
 * the end, so the thread list stays clean for demos.
 *
 *   pnpm --filter @acme/demo-api smoke [baseUrl]
 *
 * - greeting: a new thread gets a reply.
 * - choice: an unclear product gets options (buttons or text); picking one
 *   works.
 * - interrupt: a second question while the assistant works on the first; both get
 *   answered.
 * - campaign: order with office, audience, and budget up front; approve with
 *   the confirm block; the assistant reports going live and the first results.
 * - products: order tote bags; the assistant reports shipping (with tracking) and
 *   delivery.
 * - research: a performance report across campaigns, from the research
 *   specialist, in the background.
 *
 * Scenarios run at the same time, in separate chats.
 */
import { AcmeRpcs } from "@acme/demo-shared/Rpc"
import * as AssistantEvent from "effect-assistant/AssistantEvent"
import type * as ChatId from "effect-assistant/ChatId"
import * as InputId from "effect-assistant/InputId"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Socket from "effect/unstable/socket/Socket"

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "")

const layer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(`${base.replace(/^http/, "ws")}/rpc`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerNdjson)
)

type Entries = ReadonlyArray<AssistantEvent.Entry>

const ChoiceProps = Schema.Struct({ options: Schema.Array(Schema.String) })

const Status = Schema.Struct({ status: Schema.String })

const messages = AssistantEvent.assistantTexts

const blockMessages = (entries: Entries, kind: string): ReadonlyArray<AssistantEvent.AssistantMessage> =>
  entries.flatMap(({ event }) =>
    Predicate.isTagged(event, "AssistantMessage") && event.block?.kind === kind ? [event] : []
  )

const failures = (entries: Entries) =>
  entries.flatMap(({ event }) => (Predicate.isTagged(event, "TurnFailed") ? [event.message] : []))

const idle = (entries: Entries) =>
  entries.at(-1) !== undefined && Predicate.isTagged(entries.at(-1)!.event, "TurnCompleted")

/** The seq of the first fact from a source (with a status, if given). */
const factSeq = (entries: Entries, source: string, status?: string) =>
  entries.find(
    ({ event }) =>
      Predicate.isTagged(event, "Fact") &&
      event.source.startsWith(source) &&
      (status === undefined ||
        Option.exists(Schema.decodeUnknownOption(Status)(event.payload), (payload) => payload.status === status))
  )?.seq

/** Where a specialist's report arrived, if it has. */
const finishedSeq = (entries: Entries) =>
  entries.find(({ event }) => Predicate.isTagged(event, "SpecialistFinished") && event.status === "answered")?.seq

/** One line per entry, for a timeout message. */
const trace = (entries: Entries) =>
  entries
    .map(({ seq, event }) => {
      const detail =
        Predicate.isTagged(event, "UserMessage") || Predicate.isTagged(event, "AssistantMessage")
          ? event.text.slice(0, 120)
          : Predicate.isTagged(event, "ModelOutput")
            ? event.items.flatMap((item) => (item.type === "function_call" ? [item.name] : [])).join(",")
            : Predicate.isTagged(event, "ToolResult")
              ? `${event.tool}: ${event.output.slice(0, 100)}`
              : Predicate.isTagged(event, "Fact")
                ? JSON.stringify(event.payload).slice(0, 120)
                : ""

      return `  ${seq} ${event._tag} ${detail}`
    })
    .join("\n")

/** Whether the assistant said something after an entry, and is done. */
const answeredAfter = (entries: Entries, seq: number | undefined) =>
  seq !== undefined &&
  idle(entries) &&
  entries.some((entry) => entry.seq > seq && Predicate.isTagged(entry.event, "AssistantMessage"))

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

  /** Collects a chat's events until `until` holds. */
  const waitFor = (chatId: ChatId.ChatId, label: string, until: (entries: Entries) => boolean, seconds = 90) => {
    let seen: Entries = []

    return client.Subscribe({ chatId }).pipe(
      Stream.scan(
        (): Entries => [],
        (acc, entry) => [...acc, entry]
      ),
      Stream.tap((entries) => Effect.sync(() => (seen = entries))),
      Stream.takeUntil((entries) => until(entries) || failures(entries).length > 0),
      Stream.runLast,
      Effect.map(Option.getOrElse((): Entries => [])),
      Effect.timeoutOrElse({
        duration: Duration.seconds(seconds),
        orElse: () => Effect.fail(`${label}: timed out; the chat so far:\n${trace(seen)}`)
      }),
      Effect.filterOrFail(
        (entries) => failures(entries).length === 0,
        (entries) => `${label}: turn failed: ${failures(entries).join(" | ").slice(0, 400)}`
      )
    )
  }

  const send = (chatId: ChatId.ChatId, text: string) =>
    client.Submit({ chatId, input: AssistantEvent.UserMessage.make({ id: InputId.make(), text }) })

  /** Uses a block the way the web app does. */
  const answer = (
    chatId: ChatId.ChatId,
    message: AssistantEvent.AssistantMessage,
    value: Record<string, string | boolean>
  ) =>
    client.Submit({
      chatId,
      input: AssistantEvent.BlockAnswer.make({
        id: InputId.make(),
        messageId: message.id,
        kind: message.block!.kind,
        value
      })
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
      yield* waitFor(chatId, "first step", (es) => es.some(({ event }) => Predicate.isTagged(event, "ModelOutput")))
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
    "campaign: approval, live, first results",
    Effect.gen(function* () {
      const chatId = yield* newChat
      yield* send(
        chatId,
        "Order the Summer Campaign for the Amsterdam office, for parents in Austin planning trips, budget $4,000."
      )

      const parked = yield* waitFor(
        chatId,
        "approval block",
        (es) => blockMessages(es, "confirm").length > 0 && idle(es),
        150
      )

      const ask = blockMessages(parked, "confirm")[0]!
      console.log(`     campaign > ${oneLine(ask.text)} [confirm]`)
      yield* answer(chatId, ask, { confirmed: true })

      const done = yield* waitFor(
        chatId,
        "first results",
        (es) => answeredAfter(es, factSeq(es, "workflow:CreateCampaign", "first_results")),
        240
      )

      console.log(`     campaign > ${oneLine(messages(done).at(-1))}`)
    })
  )

  const products = timed(
    "products: order, shipped, delivered",
    Effect.gen(function* () {
      const chatId = yield* newChat
      yield* send(chatId, "Please order 300 cotton tote bags for the Berlin office.")

      const shipped = yield* waitFor(
        chatId,
        "shipped",
        (es) => answeredAfter(es, factSeq(es, "workflow:PrintOrder", "shipped")),
        240
      )

      if (!messages(shipped).join(" ").includes("1Z")) return yield* Effect.fail("products: no tracking number shared")

      const delivered = yield* waitFor(
        chatId,
        "delivered",
        (es) => answeredAfter(es, factSeq(es, "workflow:PrintOrder", "delivered")),
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
      const entries = yield* waitFor(chatId, "report", (es) => answeredAfter(es, finishedSeq(es)), 300)
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
