---
"effect-assistant": minor
---

The app says which chats exist, and deleting a chat keeps its log.

- **`Chats`**: `get(chatId)` returns the chat, or fails with `GetChatError` (`reason`: `"NotFound"` or `"Deleted"`). The assistant asks it before `submit` sends, when the chat stores an input, and before every model call. A chat it says is deleted is deleted then, as by `delete`. By default every chat exists from its first input.
- **`ChatDeleted`**: `MyAssistant.delete(chatId)` appends it, stops what works in the chat, and ends its subscribers' streams after the event. `ChatView` has `deleted`, and `AssistantActivity` says nothing works after it.

Breaking changes, and how to migrate:

- **`submit` can fail** with `GetChatError`, when your `Chats` says so. Without `Chats` it never does.
- **The log is kept.** `ChatLog`'s `delete` and `isDeleted` are gone, and so are `Storage`'s; `ChatLog.layerSql` no longer needs `ChatLog.DeletedChats`, which is gone. Where you kept that record, implement `Chats.get` on it instead. Removing old logs is the app's.
- **`ChatView.View` and `Update` have `deleted`.** A client that builds them by hand adds it.
