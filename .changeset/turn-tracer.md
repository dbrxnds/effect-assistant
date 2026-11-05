---
"effect-assistant": minor
---

`Assistant.TurnTracer` sets the tracer an assistant's turns and specialist runs record their spans with. Provide it to the assistant's layer, and each turn's `invoke_agent` span is the root of a trace on that tracer, with its model and tool calls below it, while the rest of the app traces elsewhere.

A handler's spans now nest under the turn that runs it. Before, an assistant's or specialist's layer passed on the tracer and span it was built with, and a handler's spans used those instead.
