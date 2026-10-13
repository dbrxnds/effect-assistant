/**
 * Defines UI blocks that an assistant can put in a message.
 *
 * A block is a bit of UI for when a structured answer is easier than typing, such as options to
 * pick from, a yes or no, or a small input. The assistant fills in its `props`, and
 * using the block sends back a value typed by its `answer` schema.
 *
 * A block made with {@link fromToolResult} shows a tool's result instead: the assistant picks the
 * result, and the client draws it from what the tool returned.
 *
 * @since 0.1.0
 */
import type * as Tool from "effect/ai/Tool"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

/**
 * Schema that a block's props or answer can use.
 *
 * It is any codec that needs no services, since the client decodes and encodes with it too.
 *
 * @category utility types
 * @since 0.1.0
 */
export type Codec = Schema.Codec<any, any>

/**
 * Represents a kind of UI block.
 *
 * @category models
 * @since 0.1.0
 */
export interface Block<Kind extends string = string, Props extends Codec = Codec, Answer extends Codec = Codec> {
  readonly kind: Kind
  /** When to use the block. The assistant sees this. */
  readonly description: string
  /** The props the assistant fills in. */
  readonly props: Props
  /** What using the block sends back, or `undefined` for a display-only card. */
  readonly answer: Answer | undefined
}

/**
 * Represents any block, for generic constraints.
 *
 * @category utility types
 * @since 0.1.0
 */
export type Any = Block

/**
 * Creates a block.
 *
 * **Details**
 *
 * A block without an `answer` schema is a display-only card. Put the block in the assistant's
 * `BlockKit` so the assistant can use it.
 *
 * **Example** (Defining a block with options to pick from)
 *
 * ```ts
 * import { Assistant, Block, BlockKit } from "effect-assistant"
 * import * as Schema from "effect/Schema"
 *
 * const PickOne = Block.make("pick_one", {
 *   description: "Options to pick from, when the user chooses between a few.",
 *   props: Schema.Struct({ options: Schema.Array(Schema.String) }),
 *   answer: Schema.Struct({ picked: Schema.String })
 * })
 *
 * export const MyAssistant = Assistant.make("my-assistant", { blocks: BlockKit.make([PickOne]) })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <const Kind extends string, Props extends Codec, Answer extends Codec = Schema.Never>(
  kind: Kind,
  options: {
    readonly description: string
    readonly props: Props
    readonly answer?: Answer | undefined
  }
): Block<Kind, Props, Answer> => ({
  kind,
  description: options.description,
  props: options.props,
  answer: options.answer
})

/**
 * Schema for the props of a block that shows a tool's result: none, since the result is the block.
 *
 * @category schemas
 * @since 0.5.0
 */
export const NoProps = Schema.Struct({})

/**
 * Represents a block that shows a tool's results, made with {@link fromToolResult}. Its kind is the
 * tool's name.
 *
 * @category models
 * @since 0.5.0
 */
export interface ToolResultBlock<T extends Tool.Any = Tool.Any> extends Block<
  Tool.Name<T>,
  typeof NoProps,
  Schema.Never
> {
  readonly tool: T
  /** The tool's success schema, which the client decodes the result with. */
  readonly result: Codec
}

/**
 * Creates a block that shows a tool's results.
 *
 * **Details**
 *
 * Put it in the assistant's `BlockKit`. The tool's results then carry a `resultId` in what the model
 * reads, and the model shows one with a `tool_result` block that names it: it never sees the
 * block's kind or how the client draws it. Sending the block fails back to the model when no
 * successful result of a shown tool has that id.
 *
 * On the client, `BlockKit.toClient` gives the block's renderer the result, decoded by the tool's
 * success schema. The tool's definition is shared with the client for that, so it can't need
 * server-only services: add those on the server with `Tool.addDependency`.
 *
 * **Example** (Showing search results as cards)
 *
 * ```ts
 * import { Block, BlockKit } from "effect-assistant"
 * import { SearchAssets } from "./tools.ts"
 *
 * export const Blocks = BlockKit.make([PickOne, Block.fromToolResult(SearchAssets)])
 *
 * // Client
 * const renderBlock = BlockKit.toClient<typeof Blocks, ReactNode>(Blocks, {
 *   pick_one: ({ props, respond }) => <Options options={props.options} onPick={respond} />,
 *   search_assets: ({ result }) => <AssetCards assets={result.items} />
 * })
 * ```
 *
 * @category constructors
 * @since 0.5.0
 */
export const fromToolResult = <T extends Tool.Any>(
  tool: T & { readonly successSchema: Codec }
): ToolResultBlock<T> => ({
  kind: tool.name,
  description: `Shows a ${tool.name} result.`,
  props: NoProps,
  answer: undefined,
  tool,
  result: tool.successSchema
})

/**
 * Returns whether a block shows a tool's results.
 *
 * @category guards
 * @since 0.5.0
 */
export const isToolResult = (block: Any): block is ToolResultBlock => Predicate.hasProperty(block, "tool")
