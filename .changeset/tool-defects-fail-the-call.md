---
"effect-assistant": patch
---

A tool handler that dies no longer ends the turn: the defect goes to the `ErrorReporter`, and the model reads that the call failed unexpectedly, so it can tell the user and carry on.
