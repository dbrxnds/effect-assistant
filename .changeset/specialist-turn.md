---
"effect-assistant": minor
---

A specialist's handler gets a turn, like an assistant's: `Specialist.Run` is `Specialist.Turn`, `run.loop(options)` is `turn.run(options)`, `Specialist.LoopOptions` is `Specialist.RunOptions` and `Specialist.RunServices` is `Specialist.TurnServices`. The handler runs once for the brief and again for messages sent to the run since, so each call is a turn of the run.
