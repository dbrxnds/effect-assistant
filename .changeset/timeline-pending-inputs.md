---
"effect-assistant": minor
---

`Timeline.withPending(timeline, inputs, at)` shows the user's sent inputs on a timeline before the chat's changes do: a message is added as the last item, a block answer marks its block answered, an approval decision marks its call decided, and the chat counts as working. Inputs the timeline already shows change nothing, and a failed one is left out, so the timeline goes back on its own. `Timeline.isPending(timeline, input)` tells whether the timeline shows an input yet.
