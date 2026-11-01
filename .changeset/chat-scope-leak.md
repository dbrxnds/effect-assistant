---
"effect-assistant": patch
---

Close what a chat sets up when the chat closes. A handler's build, its turns and the chat itself ran in the scope of the layer that registered the assistant, so nothing they acquired was released until the process stopped: a chat closed after it was idle, or deleted, kept its build's resources and background fibers (a `Resource.auto` refresh, for one), and each new activation of the chat added more. They now run in the chat's and the turn's own scope.
