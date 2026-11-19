---
"effect-assistant": minor
---

A status summary reads only this turn as what to describe, with a few earlier messages marked as context, and the lines the turn showed so far. Its model answers `-` when nothing new happened since, and the line then stays as it is, so a summary no longer repeats a line in other words or describes an earlier turn's work.

`defaultInstructions` changed to match. An app that passes its own `instructions` gets the new transcript too: tell its model to answer `-` when it has nothing new.
