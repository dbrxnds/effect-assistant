# Observability

effect-assistant emits Effect spans in the
[OpenTelemetry GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/),
so LLM tracing tools (Langfuse, Phoenix, Datadog LLM Observability) can pick
the agent's work out of a trace. There is nothing to turn on: provide a tracer,
and the spans are there.

```
invoke_agent <assistant>          one trace per turn; session.id = the chat id
├─ chat <model>             messages in and out, token usage, finish reason
├─ execute_tool <name>      arguments and result
└─ invoke_agent <specialist>
```

- **Turns** are their own traces, grouped by `session.id`, so a tool like
  Langfuse shows a chat as a session of turns. A turn's input is the inputs it
  handles; its output is what the user saw.
- **Model calls** are named after the model the loop calls, and get the standard `gen_ai.*` attributes (from Effect's
  `effect/unstable/ai/Telemetry`), cache read and write tokens, and the
  prompt's span attributes when [instructions](./instructions) carry them.
- **Tool calls** record their arguments (as `{ arguments }`) and result.

Message content is always attached. Drop or mask it in your exporter if you
don't want it sent.

The assistant's name in traces is the name in its definition:
`Assistant.make("my-assistant")` traces as `invoke_agent my-assistant`.

## Sending traces to Langfuse

Use one tracer for the whole process, and let the exporter pick what it
keeps. Langfuse's span processor exports only GenAI spans by default, so SQL,
cluster, and HTTP spans stay out:

```ts
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { LangfuseSpanProcessor } from "@langfuse/otel"

const ObservabilityLive = NodeSdk.layer(() => ({
  resource: { serviceName: "my-assistant" },
  spanProcessor: new LangfuseSpanProcessor() // reads LANGFUSE_* from the environment
}))

Layer.launch(AppLive.pipe(Layer.provide(ObservabilityLive)))
```

For a general tracing backend too, add a second span processor: it gets
everything, and Langfuse still gets only the LLM view.
