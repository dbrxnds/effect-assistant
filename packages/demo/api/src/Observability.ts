/**
 * Traces to Langfuse, when `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are
 * set (`LANGFUSE_BASE_URL` picks the region).
 *
 * One tracer for the whole process. Langfuse's span processor exports only
 * the GenAI spans effect-assistant emits (turns, model calls, tool calls,
 * specialists); SQL, cluster, and HTTP spans stay out. For a general tracing
 * backend, add a second span processor here: it would get everything.
 *
 * @since 0.1.0
 */
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { LangfuseSpanProcessor } from "@langfuse/otel"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"

/**
 * Langfuse credentials, when both keys are set.
 *
 * @category configuration
 * @since 0.1.0
 */
export const langfuse = Config.all({
  publicKey: Config.String("LANGFUSE_PUBLIC_KEY"),
  secretKey: Config.Redacted("LANGFUSE_SECRET_KEY"),
  baseUrl: Config.option(Config.String("LANGFUSE_BASE_URL"))
}).pipe(Config.option)

/**
 * Langfuse client options from {@link langfuse}.
 *
 * @category configuration
 * @since 0.1.0
 */
export const clientOptions = (credentials: Option.Option.Value<Config.Success<typeof langfuse>>) => ({
  publicKey: credentials.publicKey,
  secretKey: Redacted.value(credentials.secretKey),
  baseUrl: Option.getOrUndefined(credentials.baseUrl)
})

/** local / preview / eval, so runs don't mix in the Langfuse UI. */
const environment = Config.String("LANGFUSE_TRACING_ENVIRONMENT").pipe(
  Config.orElse(() =>
    Config.option(Config.String("RENDER")).pipe(
      Config.map((render) => Option.isSome(render) ? "preview" : "local")
    )
  )
)

/**
 * Layer that installs the tracer, or nothing without Langfuse keys.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.unwrap(Effect.gen(function*() {
  const credentials = yield* langfuse

  if (Option.isNone(credentials)) {
    yield* Effect.logInfo("tracing off: no Langfuse keys")

    return Layer.empty
  }

  const env = yield* environment
  yield* Effect.logInfo(`tracing to Langfuse (${env})`)

  return NodeSdk.layer(() => ({
    resource: { serviceName: "acme-demo" },
    spanProcessor: new LangfuseSpanProcessor({ ...clientOptions(credentials.value), environment: env })
  }))
}))
