---
"effect-assistant": minor
---

Replies as they're written. The loop streams every model call (`LanguageModel.streamText`) and reads the response whole, so the stored `ModelOutput` is what it was (its parts, model, response id, usage, and duration). While the model writes a `send_user_message` call, the chat sends what the assistant is composing to its live subscribers: `ChatView.Activity` has `composing`, `{ text }` with the message's text so far, parsed from the call's params as they stream. It isn't stored and never reaches the log: it goes in the update that brings the message, or when the step ends without it (sent, failed, or interrupted). Nothing else of the model's work streams to the client. `EagerInput.anthropic()` is a `transformClient` for `@effect/ai-anthropic`'s `AnthropicClient` that sets `eager_input_streaming: true` on `send_user_message`, so Anthropic streams the text a few words at a time rather than in a few big pieces.

Breaking changes, and how to migrate:

- **The loop calls `streamText`.** A scripted `LanguageModel` in tests that implements only `generateText` answers with `streamText` instead: its stream can be the same parts, a tool call whole as one `tool-call` part (see the testing guide).
- **`AssistantEngine`'s `subscribe` streams `AssistantEvent.Composing` too**, between the entries. `MyAssistant.subscribe` leaves it out; an engine of your own, or code that calls the engine's `subscribe`, handles it. `ChatView.updates` takes both.
- **`ChatView.Activity` has an optional `composing`.** A client that builds updates itself, or compares activities, has the new field.
