---
"effect-assistant": minor
---

`ChatId.make()` and `InputId.make()` are functions returning an Effect (still on Effect's `Random`, so tests can seed them): `yield* ChatId.make()`. `UserMessage.make({ text })` gets a new id when none is given; pass the client's own to make a retried send store the message once.
