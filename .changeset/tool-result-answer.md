---
"effect-assistant": minor
---

`Block.fromToolResult` takes an optional `answer` schema, so the user can act on a tool's result, e.g. tick some of the items a search found. The block then sends a `BlockAnswer` like any other block: the renderer gets `open`, `answer` and a typed `respond`, and the answer stays on the message.

```ts
const PickItems = Block.fromToolResult(SearchItems, {
  answer: Schema.Struct({ picked: Schema.Array(Schema.String) })
})
```
