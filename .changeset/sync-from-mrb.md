---
"effect-assistant": minor
---

Sync with the version running in production, on effect 4.0.0 (AI, cluster, and workflow modules moved out of `effect/unstable/*`).

New: `Memory` (facts across chats, per personal and team scope, with `remember` / `forget` / `recall` tools), `Compaction` (a summary in place of a long chat's start), and `Eval` (pass rates over repeated trials, with a model judge).

Breaking changes, and how to migrate:

- **`AssistantLoop.tools` is `AssistantLoop.fromToolkit`**, with the same arguments. `Skill.toolkit` is `Skill.toTools`, and `Decision.states` is `Decision.fromEntries`.
- **`ChatLog.layerSql` creates no tables** and needs a `ChatLog.DeletedChats`: where the app records that a chat was deleted. Create `chat_log` (`chat_id`, `seq`, `at`, `event`; primary key `chat_id, seq`) in a migration.
- **effect 4.0.0**: imports from `effect/unstable/ai/*`, `effect/unstable/cluster/*`, and so on become `effect/ai/*`, `effect/cluster/*`.
