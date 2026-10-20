/**
 * The Anthropic API, for the contract tests, with prompt caching as an app
 * would set it. Needs ANTHROPIC_API_KEY (loaded from .env.local).
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

/** A small, fast model: the contract tests check behaviour, not wording. */
export const testModel = "claude-haiku-4-5"

/** Without a key (a fork, or CI without the secret) the contract tests are skipped, not failed. */
export const hasApiKey = (process.env.ANTHROPIC_API_KEY ?? "") !== ""

export const realModel = AnthropicLanguageModel.model(testModel, { cache_control: { type: "ephemeral" } }).pipe(
  Layer.provide(AnthropicClient.layer({ apiKey: Redacted.make(process.env.ANTHROPIC_API_KEY ?? "") })),
  Layer.provide(FetchHttpClient.layer)
)
