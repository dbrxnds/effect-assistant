---
"effect-assistant": patch
---

`StatusSummary.layer({ after: 0 })` summarizes as soon as the turn starts; its checks run at least 100 ms apart, so a zero `after` or `staleAfter` doesn't spin.
