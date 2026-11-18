---
"effect-assistant": minor
---

A tool opts into a status line with a field on its parameters instead of an annotation. `ToolStatus.withStatus` adds a required `description` field to a `Schema.Struct`, and the handler gets it like any other parameter. A struct that has a `description` field already is a type error, and a `description` parameter without `withStatus` shows no status. `ToolStatus.Described` and `ToolStatus.described` are gone.

Before:

```ts
const ArchiveNote = ToolStatus.described(
  Tool.make("archive_note", {
    parameters: Schema.Struct({ noteId: Schema.String }),
    success: Schema.Struct({ archived: Schema.Boolean })
  })
)
```

After:

```ts
const ArchiveNote = Tool.make("archive_note", {
  parameters: Schema.Struct({ noteId: Schema.String }).pipe(ToolStatus.withStatus),
  success: Schema.Struct({ archived: Schema.Boolean })
})
```
