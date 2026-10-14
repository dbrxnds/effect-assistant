---
"effect-assistant": minor
---

Names are spelled out, and a turn runs its loop with `turn.run`.

- `turn.loop(options)` is now `turn.run(options)`, and `Assistant.LoopOptions` is `Assistant.RunOptions`. A specialist's `run.loop` is unchanged.
- `seq` is now `sequence` everywhere: `Entry.sequence`, `Timeline.sequence`, `Change.sequence`, `ChatHistory.throughSequence`, `Compaction.Summary.throughSequence`, `TurnEnded`/`TurnFailed.throughSequence`, `ModelOutput.seenThroughSequence` and `ChatLog`'s storage `lastSequence`.

Stored events use the new field names. For a `ChatLog.layerSql` table, in Postgres:

```sql
ALTER TABLE chat_log RENAME COLUMN seq TO sequence;
UPDATE chat_log
SET event = replace(replace(event, '"seenThroughSeq":', '"seenThroughSequence":'), '"throughSeq":', '"throughSequence":')
WHERE event LIKE '%ThroughSeq":%' OR event LIKE '%"throughSeq":%';
```

An app's own summary event with a `throughSeq` field needs the same replace.
