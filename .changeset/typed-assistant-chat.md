---
"effect-assistant": minor
---

`yield* MyAssistant.Chat` is the chat an assistant's turn runs in, typed with its events: its `entries` carry them typed (narrow with `Predicate.isTagged(event, "Summary")`), and its `append` takes only them and the library's, so an unregistered event is a type error. The handler, its build, and any tool its turns run get it; `toLayer` counts it as provided by the turn. `CurrentChat` stays for code that doesn't know the assistant, like a shared tool or a specialist's run.
