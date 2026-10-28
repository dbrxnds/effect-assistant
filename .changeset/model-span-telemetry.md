---
"effect-assistant": minor
---

A model call is traced once. The loop no longer wraps `LanguageModel.generateText` in its own `chat` span: the prompt (`gen_ai.prompt`), the completion (`gen_ai.completion`), the instructions' span attributes and the usage go on Effect's own `LanguageModel.generateText` span, through `Telemetry.CurrentSpanTransformer`. LLM tools such as Langfuse counted the call, and its cost, twice before. A `CurrentSpanTransformer` provided around the turn still runs first; one that a provider layer sets at construction is replaced for the loop's calls.
