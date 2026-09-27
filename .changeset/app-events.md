---
"effect-assistant": minor
---

The app's own events and inputs are stored as themselves, in their schema's JSON form: `Assistant.make(name, { events, inputs })` takes tagged schemas. Inputs wake a turn, `submit` takes them, and the model reads them; `turn.entries` and `subscribe` decode both to their types, and `MyAssistant.Entry` is the schema for an RPC that streams them. `AssistantEvent.Custom` is gone. `AssistantHistory` is gone too: a history view (`turn.loop({ history })`, `turn.history(view)`) picks which entries the model reads and what goes with them. `ClientInput` is `UserInput` (and `isUserInput`): the inputs a turn owes a reply. `AssistantEvent.Entry` is a struct now, not a class.
