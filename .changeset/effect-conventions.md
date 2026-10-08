---
"effect-assistant": patch
---

Follow Effect's source conventions: every export has `@category` and `@since`, internals are `@internal` with terse why-comments, and spans are added with `Effect.withSpan` on `Effect.fnUntraced` (same span names). Library events are recognized by their `_tag`, not their schema identifier.
