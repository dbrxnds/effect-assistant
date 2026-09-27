/**
 * The `ToolDiscovery` module turns a toolkit into two tools, so the prompt
 * doesn't carry every definition: `search_tools` finds tools by what the
 * model needs to do (name, description, input schema), and `execute_tool`
 * validates an input and runs one.
 *
 * Use it for tools that change at runtime (MCP servers, plugins) or catalogs
 * too big for the prompt. Fixed, frequently used tools belong in the toolkit
 * directly.
 *
 * **Example** (Common tools up front, the rest on demand)
 *
 * ```ts
 * import { AssistantLoop, ToolDiscovery } from "effect-assistant"
 *
 * const MyAssistantLive = MyAssistant.toLayer(Effect.gen(function*() {
 *   const toolkit = AssistantLoop.merge(
 *     AssistantLoop.tools(yield* OrderTools),
 *     ToolDiscovery.make(AssistantLoop.tools(yield* OfficeTools))
 *   )
 *
 *   return (turn) => turn.loop({ instructions: "You help a small team.", toolkit })
 * }))
 * ```
 *
 * @since 0.1.0
 */
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as Response from "effect/unstable/ai/Response"
import type * as AssistantLoop from "./AssistantLoop.ts"
import { toJson } from "./internal/schema.ts"
import * as Toolkits from "./internal/toolkit.ts"
import * as Uuid from "./internal/uuid.ts"

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
    Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String), inputSchema: Schema.Json })
  )
})

const ExecuteTool = Tool.make("execute_tool", {
  description: "Run a tool found with search_tools. Pass its name and an input matching its input schema.",
  parameters: Schema.Struct({ name: Schema.String, input: Schema.Record(Schema.String, Schema.Json) }),
  success: Schema.Json,
  // The tool's failure is this call's, so the loop sees it failed (a `wait: true` message doesn't end the turn).
  failure: Schema.Json
})

/**
 * Creates `search_tools` and `execute_tool` for these tools.
 *
 * **Details**
 *
 * Search scores the query's words against tool names and descriptions and
 * returns the top five. `execute_tool` runs the tool the way a model call
 * would, so its input is validated, and a failure of the tool is a failure
 * of `execute_tool`, with the tool's result.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R>(tools: AssistantLoop.Tools<R>): AssistantLoop.Tools<R> =>
  Toolkits.withContext(Toolkit.make(SearchTools, ExecuteTool), (context: Context.Context<R>) => ({
    search_tools: ({ query }) =>
      Effect.sync(() =>
        search(tools.definitions, query, 5).map((tool) => ({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: toJson(Tool.getJsonSchema(tool))
        }))
      ),
    execute_tool: ({ name, input }) =>
      Effect.gen(function* () {
        const call = Response.makePart("tool-call", {
          id: `execute_${yield* Uuid.random}`,
          name,
          params: input,
          providerExecuted: false
        })

        const { outcome, result } = yield* tools.run(call)

        return outcome === "failure" ? yield* Effect.fail(result) : result
      }).pipe(Effect.provideContext(context))
  }))
