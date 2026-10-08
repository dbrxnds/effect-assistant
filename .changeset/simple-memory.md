---
"effect-assistant": minor
---

Memory is a toolkit over a store the app implements. `Memory.MemoryStore` has `facts`, `remember`, `forget`, and `recall`, each given the chat it's for: the app decides whose facts that means. `Memory.Tools` (with `Memory.layerTools`) call it for the chat they run in, and `Memory.render(facts)` writes the facts for a turn's instructions.

Breaking changes, and how to migrate:

- **Scopes are gone**, and so are `Memory.CurrentScopes`, `Memory.Scopes`, and `Memory.facts(scopes)`: implement `MemoryStore` and map a chat to its owner yourself.
- **A fact is `{ id, text, expiresAt? }`.** `kind` is gone: a short-lived fact has an `expiresAt` (the model passes `until`), a lasting one doesn't. `log` lines and `Memory.log` are gone: keep them in your store, from your own code.
- **`Memory.layerSql` is gone**: the store is yours. `Memory.layerMemory` stays, for tests and local runs.
- **`Memory.render(facts)` returns a string**, empty when there are none.
