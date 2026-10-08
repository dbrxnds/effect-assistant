/**
 * The `ToolDiscovery` module turns a catalog toolkit into two tools, so the
 * prompt doesn't carry every definition: `search_tools` finds tools by what the
 * model needs to do (name, description, input schema), and `execute_tool`
 * validates an input and runs one.
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

/** How many query words appear in the text, counting prefixes ("ship" matches "shipment"). */
const score = (query: ReadonlySet<string>, text: string): number => {
  const target = [...words(text)]

  const matches = (word: string) =>
    target.some((t) => t === word || (word.length >= 4 && (t.startsWith(word) || word.startsWith(t))))

  return [...query].filter(matches).length
}

/** Best matches first; everything when nothing matches, so the model can pick or search again. */
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
  // The tool's failure is this call's, so the loop sees it failed (a `wait: true` message doesn't end the turn).
  failure: Schema.Json,
  dependencies: [AssistantToolCall]
})

/**
 * Returns a tool with these requirements: a tool's requirements are a
 * covariant phantom type, so one that needs nothing is one that needs any.
 */
const requiring =
  <R>() =>
  <N extends string, C extends (Tool.Any extends Tool.Tool<string, infer K, unknown> ? K : never), R0>(
    tool: Tool.Tool<N, C, R0>
  ): Tool.Tool<N, C, R0 | R> =>
    tool

/**
 * `search_tools` and `execute_tool` over a catalog toolkit, as a native
 * toolkit and its handlers' layer. Merge the toolkit into the loop's, and
 * provide the layer, which needs the catalog's handlers. A catalog tool's
 * services are `execute_tool`'s: the turn provides them, as for any tool.
 */
export const make = <T extends Record<string, Tool.Any>>(catalog: Toolkit.Toolkit<T>) => {
  const Tools = Toolkit.make(SearchTools, requiring<Toolkits.ToolServices<T>>()(ExecuteTool))

  const layer = Tools.toLayer(
    Effect.gen(function* () {
      const resolved = yield* catalog
      const definitions = Object.values(resolved.tools)

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

          // A call that needs the user's decision parks only as a call the model made itself, where it can ask for it.
          if (yield* Toolkits.needsDecision(resolved, call, [])) {
            return yield* Effect.fail(
              Toolkits.failed(
                `${name} needs the user's decision, so it can't run through execute_tool.`,
                "needs_decision"
              ).result
            )
          }

          const { outcome, result } = yield* Toolkits.runNative(resolved, call)

          return outcome === "failure" ? yield* Effect.fail(result) : result
        })
      }
    })
  )

  return { toolkit: Tools, layer }
}
