---
"effect-assistant": minor
---

Renames and small API fixes, with no compatibility aliases:

- `AssistantChat` → `CurrentChat` (the module, `AssistantChat.AssistantChat` → `CurrentChat.CurrentChat`, and its key `"effect-assistant/AssistantChat"` → `"effect-assistant/CurrentChat"`). In a specialist's run it is the chat the run belongs to.
- `Chats.Chat` → `Chats.ChatRecord`
- `AssistantActivity.Activity` → `AssistantActivity.State`
- `ChatView.Decision` → `ChatView.PendingDecision` (the schema and its type)
- `BlockKit.nextBlockStates` → `BlockKit.apply`, `BlockKit.blockStates` → `BlockKit.fromEntries`, `BlockKit.BlockState` → `BlockKit.State`
- `Specialist.SpawnRequest.kind` → `Specialist.SpawnRequest.specialist`, and the `spawn_specialist` tool's `kind` parameter → `specialist`
- `Runner.message(runId: string, …)` → `Runner.message(runId: RunId, …)`, `Runner.stop(runId: string)` → `Runner.stop(runId: RunId)`; the `message_specialist` and `stop_specialist` tools decode `runId` with the `RunId` schema
- `SpecialistError` gains `reason`: `"UnknownSpecialist"`, `"RunNotFound"`, or `"NotRunning"`. The specialist tools fail with it as the `ToolFailure`'s reason.
- `RunId.make` (an Effect) → `RunId.make()` (a function returning an Effect), like `ChatId.make()` and `InputId.make()`
- `ToolFailure.kind` → `ToolFailure.reason`, `ToolFailure.fail(message, { kind })` → `ToolFailure.fail(message, { reason })`, and `AssistantEvent.ToolResult.kind` → `AssistantEvent.ToolResult.reason`
- The library's failure reasons are PascalCase: `"needs_decision"` → `"NeedsDecision"`, `"not_waiting_for_decision"` → `"NotWaitingForDecision"`, `"decision_waiting"` → `"DecisionWaiting"`, `"empty_message"` → `"EmptyMessage"`, `"may_have_run"` → `"MayHaveRun"`, `"not_run"` → `"NotRun"`, `"not_now"` → `"NotNow"` (`"NoResult"`, `"ToolNotFoundError"`, and `"ToolParameterValidationError"` stay)
- `Schema.TaggedError` → `Schema.Error` with a `_tag` for `Chats.GetChatError` (`"effect-assistant/Chats/GetChatError"`), `Specialist.SpecialistError` (`"effect-assistant/Specialist/SpecialistError"`), and `ToolFailure.ToolFailure` (`"effect-assistant/ToolFailure/ToolFailure"`). `new GetChatError({ chatId, reason })` and `catchTag("GetChatError")` work as before.
- `ToolDiscovery.make(catalog)` → `{ toolkit, layer }` becomes `ToolDiscovery.make(catalog)` → the toolkit, and `ToolDiscovery.layer(catalog)` → its handlers' layer
- `Skill.make({ name, description, instructions })` → `Skill.make(name, { description, instructions })`
- Brands `"effect-assistant/ChatId"` → `"~effect-assistant/ChatId"`, and the same for `InputId`, `RunId`, `DecisionId`, and `AssistantEvent.AppTag`
- An assistant's definition has a `"~effect-assistant/Assistant"` type id, and `Assistant.isAssistant` checks for it
- `AssistantEvent.MAX_ATTACHMENTS` → `AssistantEvent.maxAttachments`
