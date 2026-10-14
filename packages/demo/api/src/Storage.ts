/**
 * Storage for the whole process. With `DATABASE_URL`: one Postgres pool shared
 * by the assistant event log, the thread list, the live orders, and the cluster
 * runner (entities and workflows). Without it: everything in memory.
 *
 * @since 0.1.0
 */
import * as PgClient from "@effect/sql-pg/PgClient"
import * as ChatLog from "effect-assistant/ChatLog"
import * as Config from "effect/Config"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import * as Redacted from "effect/Redacted"
import type * as MessageStorage from "effect/cluster/MessageStorage"
import * as RunnerAddress from "effect/cluster/RunnerAddress"
import type * as Sharding from "effect/cluster/Sharding"
import * as SingleRunner from "effect/cluster/SingleRunner"
import * as TestRunner from "effect/cluster/TestRunner"
import { createHash, randomBytes } from "node:crypto"
import * as Chats from "./Chats.ts"
import * as LiveOrders from "./LiveOrders.ts"

/**
 * PlanetScale URLs carry `sslrootcert=system`, which node-postgres reads as a
 * file path. Drop it; `sslmode` stays.
 */
const sanitizeDatabaseUrl = (raw: string): string =>
  raw
    .replace(/([?&])(sslrootcert|sslaccept)=[^&]*/gi, "$1")
    .replace(/\?&+/g, "?")
    .replace(/&&+/g, "&")
    .replace(/[?&]$/, "")

/** `DATABASE_URL`, when set and not blank. */
const databaseUrl = Config.option(Config.String("DATABASE_URL")).pipe(
  Config.map(Option.filter((url) => url.trim().length > 0)),
  Config.map(Option.map((url) => sanitizeDatabaseUrl(url.trim())))
)

const layerPg = (url: string, maxConnections: number) =>
  PgClient.layer({
    url: Redacted.make(url),
    maxConnections,
    idleTimeout: "30 seconds",
    connectTimeout: "10 seconds"
  })

const digestName = (algorithm: Crypto.DigestAlgorithm) =>
  ({ "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" })[algorithm]

const layerNodeCrypto = Layer.sync(Crypto.Crypto, () =>
  Crypto.make({
    randomBytes: (size) => randomBytes(size),
    digest: (algorithm, data) =>
      Effect.sync(() => new Uint8Array(createHash(digestName(algorithm)).update(data).digest()))
  })
)

// ChatLog.layerSql() expects its table; the demo creates it on start, an app would migrate it.
const layerChatLogTable = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
      CREATE TABLE IF NOT EXISTS chat_log (
        chat_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        at DOUBLE PRECISION NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (chat_id, sequence)
      )
    `
  })
)

/** One runner that owns every shard, with SQL storage. */
const layerSqlRunner = SingleRunner.layer({
  runnerStorage: "sql",
  shardingConfig: { runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", 34431)) }
}).pipe(Layer.provide(layerNodeCrypto))

type Services =
  | ChatLog.ChatLog
  | Chats.Chats
  | LiveOrders.LiveOrders
  | Sharding.Sharding
  | MessageStorage.MessageStorage

const layerFor = (url: Option.Option<string>, maxConnections: number): Layer.Layer<Services, unknown> =>
  Option.isNone(url)
    ? Layer.mergeAll(ChatLog.layerMemory, Chats.layerMemory, LiveOrders.layerMemory, TestRunner.layer)
    : Layer.mergeAll(
        ChatLog.layerSql().pipe(Layer.provide(layerChatLogTable)),
        Chats.layerSql,
        LiveOrders.layerSql,
        layerSqlRunner
      ).pipe(Layer.provideMerge(layerPg(url.value, maxConnections)))

/**
 * Layer that provides the event log, the thread list (also as the assistant's
 * `Chats`), and the cluster runner:
 * on Postgres when `DATABASE_URL` is set, in memory otherwise.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Services, unknown> = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* databaseUrl
    const maxConnections = yield* Config.Int("ACME_PG_MAX_CONNECTIONS").pipe(Config.withDefault(8))
    yield* Effect.logInfo(`storage: ${Option.isSome(url) ? "postgres" : "memory"}`)

    // The assistant asks the thread list which chats exist: the engine and the server see it from here.
    return Chats.layerLibraryChats.pipe(Layer.provideMerge(layerFor(url, maxConnections)))
  })
)
