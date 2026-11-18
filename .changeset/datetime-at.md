---
"effect-assistant": minor
---

Every point in time the library exposes is now a `DateTime.Utc` instead of a number of epoch milliseconds: an entry's `at` (`AssistantEvent.Entry`, `AssistantEvent.AnyEntry`, `Assistant.Entry`), the timeline's items' `at` (`UserMessage`, `AssistantMessage`, app event items, `ToolApproval` items), a block's `answeredAt`, `SpecialistWorking.since`, `ToolApproval.State.at`, and `AssistantActivity`'s `turnSince` and `since`. The schemas use `Schema.DateTimeUtcFromMillis`, so they still encode as epoch milliseconds: stored rows and the wire format are unchanged.

```ts
// Before
new Date(item.at)
Timeline.UserMessage.make({ id, text, at: Date.now() })
AssistantEvent.Entry.make({ chatId, sequence: 1, at: 0, event })

// After
DateTime.toDate(item.at)
Timeline.UserMessage.make({ id, text, at: DateTime.nowUnsafe() })
AssistantEvent.Entry.make({ chatId, sequence: 1, at: DateTime.makeUnsafe(0), event })
```

A custom `ChatLog.Storage` now receives and returns entries with a `DateTime.Utc` `at`: convert with `DateTime.toEpochMillis` when writing and `DateTime.makeUnsafe` when reading.
