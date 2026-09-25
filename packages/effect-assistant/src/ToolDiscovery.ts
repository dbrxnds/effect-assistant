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
 * import * as Toolkit from "@effect-uai/core/Toolkit"
 * import { ToolDiscovery } from "effect-assistant"
 *
 * const toolkit = {
 *   ...Toolkit.make(listProducts, startCampaign),
 *   ...ToolDiscovery.make(Toolkit.make(offices, shipmentEta))
 * }
 * ```
 *
 * @since 0.1.0
 */
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as ToolResultWire from "@effect-uai/core/ToolResult"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { nanoid } from "nanoid"

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
const search = (tools: ReadonlyArray<Tool.AnyTool>, query: string, limit: number): ReadonlyArray<Tool.AnyTool> => {
  const queryWords = words(query)

  const ranked = tools
    .flatMap((tool) => {
      const hits = score(queryWords, `${tool.name} ${tool.description}`)

      return hits > 0 ? [{ tool, score: hits }] : []
    })
    .sort((a, b) => b.score - a.score)

  return (ranked.length > 0 ? ranked.map((hit) => hit.tool) : tools).slice(0, limit)
}

const ExecuteInput = Schema.Struct({
  name: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown)
})

/**
 * Creates `search_tools` and `execute_tool` for a toolkit.
 *
 * **Details**
 *
 * Search scores the query's words against tool names and descriptions and
 * returns the top five. `execute_tool` runs the tool the way a model call
 * would, so its input is validated and its failures come back as results.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <Tools extends Toolkit.Toolkit>(toolkit: Tools) => {
  const tools: ReadonlyArray<Tool.AnyTool> = Object.values(toolkit)

  const searchTools = Tool.make({
    name: "search_tools",
    description:
      "Search for more tools by what you need to do. Returns their names, descriptions, and input schemas; call one with execute_tool.",
    inputSchema: Schema.Struct({
      query: Schema.String.annotate({ description: "What you need to do, in a few words." })
    }),
    run: ({ query }) =>
      Effect.sync(() =>
        search(tools, query, 5).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: Tool.toDescriptors([tool])[0]?.inputSchema
        }))
      )
  })

  const executeTool = Tool.make({
    name: "execute_tool",
    description: "Run a tool found with search_tools. Pass its name and an input matching its input schema.",
    inputSchema: ExecuteInput,
    run: Effect.fn(function* ({ name, input }: typeof ExecuteInput.Type) {
      if (!Object.hasOwn(toolkit, name)) return yield* Tool.fail(`No tool named ${name}. Use search_tools.`)

      const call = {
        type: "function_call" as const,
        call_id: `execute_${nanoid(8)}`,
        name,
        arguments: JSON.stringify(input)
      }

      const results = yield* Toolkit.collectResults(Toolkit.run(toolkit, [call]))

      return results.map((result) => ToolResultWire.toToolCallOutput(result).output).join("\n")
    })
  })

  return Toolkit.make(searchTools, executeTool)
}
