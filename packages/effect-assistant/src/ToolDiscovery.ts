/**
 * Turns a catalog toolkit into two tools, so the prompt doesn't carry every tool definition.
 *
 * `search_tools` finds tools by what the model needs to do and returns their names, descriptions,
 * and input schemas. `execute_tool` validates an input and runs one of them. {@link make} returns
 * the two tools as a native toolkit, and {@link layer} their handlers.
 *
 * @since 0.1.0
 */
import * as Response from "effect/ai/Response"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { AssistantToolCall } from "./AssistantToolCall.ts"
import { toJson } from "./internal/schema.ts"
import * as Toolkits from "./internal/toolkit.ts"

const words = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3)
  )

const score = (query: ReadonlySet<string>, text: string): number => {
  const target = [...words(text)]

  const matches = (word: string) =>
    target.some((t) => t === word || (word.length >= 4 && (t.startsWith(word) || word.startsWith(t))))

  return [...query].filter(matches).length
}

// Everything when nothing matches, so the model can pick or search again.
const search = (tools: ReadonlyArray<Tool.Any>, query: string, limit: number): ReadonlyArray<Tool.Any> => {
  const queryWords = words(query)

  const ranked = tools
    .flatMap((tool) => {
      const hits = score(queryWords, `${tool.name} ${Tool.getDescription(tool) ?? ""}`)

      return hits > 0 ? [{ tool, score: hits }] : []
    })
    .sort((a, b) => b.score - a.score)

  return (ranked.length > 0 ? ranked.map((hit) => hit.tool) : tools).slice(0, limit)
}

const SearchTools = Tool.make("search_tools", {
  description:
    "Search for more tools by what you need to do. Returns their names, descriptions, and input schemas; call one with execute_tool.",
  parameters: Schema.Struct({
    query: Schema.String.annotate({ description: "What you need to do, in a few words." })
  }),
  success: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      inputSchema: Schema.Json
    })
  )
})

const ExecuteTool = Tool.make("execute_tool", {
  description: "Run a tool found with search_tools. Pass its name and an input matching its input schema.",
  parameters: Schema.Struct({
    name: Schema.String,
    input: Schema.Record(Schema.String, Schema.Json)
  }),
  success: Schema.Json,
  // The tool's failure is this call's, so the loop sees it failed (a `wait: true` message doesn't
  // end the turn).
  failure: Schema.Json,
  dependencies: [AssistantToolCall]
})

// A tool's requirements are a covariant phantom type, so one that needs nothing is one that needs
// any.
const requiring =
  <R>() =>
  <N extends string, C extends (Tool.Any extends Tool.Tool<string, infer K, unknown> ? K : never), R0>(
    tool: Tool.Tool<N, C, R0>
  ): Tool.Tool<N, C, R0 | R> =>
    tool

/**
 * Creates the `search_tools` and `execute_tool` tools over a catalog toolkit, as a native toolkit.
 *
 * **Details**
 *
 * Merge the toolkit into the loop's, and provide {@link layer} for the same catalog, which has
 * the tools' handlers. A catalog tool's services are `execute_tool`'s, so the turn provides them
 * as it does for any tool.
 *
 * A catalog tool with Effect's `needsApproval` set fails the layer when it is built, as it would
 * fail a loop: the library doesn't run calls that wait for approval.
 *
 * **Example** (Finding rarely used tools when needed)
 *
 * ```ts
 * import { ToolDiscovery } from "effect-assistant"
 * import * as Toolkit from "effect/ai/Toolkit"
 * import * as Layer from "effect/Layer"
 *
 * // OfficeTools is a big toolkit, found when needed. CommonTools stays in the prompt.
 * const OfficeDiscovery = ToolDiscovery.make(OfficeTools)
 * const OfficeDiscoveryLive = ToolDiscovery.layer(OfficeTools).pipe(Layer.provide(OfficeToolsLive))
 *
 * const MyAssistantLive = MyAssistant.toLayer((turn) =>
 *   turn.loop({
 *     instructions,
 *     toolkit: Toolkit.merge(CommonTools, OfficeDiscovery)
 *   })
 * ).pipe(Layer.provide([CommonToolsLive, OfficeDiscoveryLive]))
 * ```
 *
 * @see {@link layer} for the tools' handlers
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <T extends Record<string, Tool.Any>>(
  // Only its type is used here, for `execute_tool`'s services: `layer` runs its tools.
  _catalog: Toolkit.Toolkit<T>
) => Toolkit.make(SearchTools, requiring<Toolkits.ToolServices<T>>()(ExecuteTool))

/**
 * Creates the layer with the handlers of the `search_tools` and `execute_tool` tools over a
 * catalog toolkit.
 *
 * **Details**
 *
 * The layer needs the catalog's handlers. It provides the handlers of the toolkit that
 * {@link make} returns for the same catalog: handlers are keyed by tool name, so the two calls
 * don't need to share a value. Give both the same catalog.
 *
 * @see {@link make} for the toolkit and an example
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = <T extends Record<string, Tool.Any>>(catalog: Toolkit.Toolkit<T>) =>
  make(catalog).toLayer(
    Effect.gen(function* () {
      const resolved = yield* catalog
      const definitions = Object.values(resolved.tools)
      const needingApproval = Toolkits.needingApproval(definitions)

      if (needingApproval.length > 0) return yield* Effect.die(Toolkits.needsApprovalMessage(needingApproval))

      return {
        search_tools: ({ query }) =>
          Effect.sync(() =>
            search(definitions, query, 5).map((tool) => ({
              name: tool.name,
              description: Tool.getDescription(tool),
              inputSchema: toJson(Tool.getJsonSchema(tool))
            }))
          ),
        execute_tool: Effect.fnUntraced(function* ({ name, input }) {
          // Named after the call that runs it: the same id when a crash runs that call again.
          const outer = yield* AssistantToolCall

          const call = Response.makePart("tool-call", {
            id: `${outer.callId}:${name}`,
            name,
            params: input,
            providerExecuted: false
          })

          const { outcome, result } = yield* Toolkits.runNative(resolved, call)

          return outcome === "failure" ? yield* Effect.fail(result) : result
        })
      }
    })
  )
