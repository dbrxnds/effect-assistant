# effect-assistant

## 0.4.0

### Minor Changes

- ad6281d: Skills are a toolkit, and a tool call can wait for the user's approval.
  
  - **`Skill.toolkit(skills)`** is a toolkit with one tool, `load_skill`, whose description is the catalog: each skill's name and when to use it. Merge it into a loop's toolkit like any other, `Toolkit.merge(MyTools, AssistantSkills)`, and provide `AssistantSkills.layer`, the handler that resolves the skills' instructions; it requires the services they need, like any tool handler. A name that isn't in the list is a failure the model reads, with the names there are. The handler resolves only its own list, so to offer each user the skills their role allows, build the toolkit in the turn from their list and provide its layer to the loop's stream (`Stream.provide(skills.layer)`).
  - **Tools made with Effect's `needsApproval` wait for the user.** A turn's call to one doesn't run: the turn records it (`AssistantEvent.ApprovalRequested`), gives the model a placeholder result for it, and ends; the step's other calls run as usual. A `needsApproval` function decides per call, from its params.
    - The user's decision is an input, `AssistantEvent.ApprovalDecision`, built with `ToolApproval.approve(item)` or `ToolApproval.reject(item, { reason })` and submitted like a message. Its id is fixed per call, so a double click is stored once, and one for a call that isn't waiting any more isn't stored. It wakes a turn.
    - An approved call runs at the start of that turn's loop, with the params the model gave it and the same call id, so `AssistantToolCall.idempotencyKey` is the key the call would have had; a crash before its result runs it again with that key. The model reads the result as the outcome of its earlier call. A rejected call doesn't run, and the model reads the rejection and the user's reason.
    - `ToolApproval.closeStale({ messages: 10 })`, run from a handler like `BlockKit.closeStale`, expires calls the user moved on from (`AssistantEvent.ApprovalsExpired`): the model reads that they weren't approved. `ToolApproval.fromEntries` folds where each call stands, and `Compaction.openItems` lists the ones still waiting.
    - On the timeline, every call that waits is a `Timeline.ApprovalItem`, `{ _tag: "ToolApproval", id, tool, status, reason, outcome, at }`, updated in place as it's decided and run. It's only the yes or no: the assistant's message, sent with the call, says what it asks the user to approve, so the item carries no params and the client needs nothing of the tool. It's always on the timeline, with no option on `Timeline.Change` or `Timeline.changes`.
    - Only a turn can ask the user: a specialist's run that calls such a tool gets a failure it reads, and `ToolDiscovery` still refuses one in its catalog.
  
  Breaking changes, and how to migrate:
  
  - **`turn.loop` and a specialist's `run.loop` take no `skills`**, and the prompt has no skills catalog. `turn.loop({ instructions, toolkit: MyTools, skills: [a, b] })` becomes `turn.loop({ instructions, toolkit: Toolkit.merge(MyTools, Skills) })` with `const Skills = Skill.toolkit([a, b])`, and `Layer.provide(Skills.layer)` where the tools' layers are provided. A skill's instructions resolve with the services given to that layer, no longer with the loop's: provide them to the layer, or to the loop's stream for a toolkit built per turn. `Assistant.LoopOptions` and `Specialist.LoopOptions` lose their `RS` type parameter (`LoopOptions<T, Events>` and `LoopOptions<T>`), and `Skill.withCatalog` is gone.
  - **`Skill.make` takes no `tools`**, and skills are no longer left out for a loop that lacks their tools: a skill says how to do a kind of task, and the model works with the tools it has. To offer a skill only to some users, build their list per turn (see above).
  - **A loop with a `needsApproval` tool no longer fails**: its calls wait for the user. Work you put behind a block whose button calls your own API (with an app event to tell the chat) can be a `needsApproval` tool the model calls with the details: the user approves the call, and it runs as the tool's handler, keyed with `AssistantToolCall.idempotencyKey`. Blocks with an `answer` schema still collect input, answered with the client's `respond`.
  - **The library's events and inputs have three more members**: `ApprovalRequested`, `ApprovalDecision`, and `ApprovalsExpired` join `AssistantEvent.AssistantEvent`, and `ApprovalDecision` joins `Input` and `UserInput`, so a chat client may submit it. Code that switches over them exhaustively handles the new tags. `AssistantLoop.Event` can be an `ApprovalRequested`.
  - **A timeline's items include `Timeline.ApprovalItem`**, so code that matches over them exhaustively handles `ToolApproval`.

## 0.3.0

### Minor Changes

- be3a24a: The app's own events are plain schemas, and the app decides what happens with them where it uses them: where an event comes from says whether it wakes a turn, the history view says how the model reads it, and the chat's timeline (what was `ChatView`) says whether the user sees it.

  - **`Assistant.make(name, { events: [OrderPlaced, Summary] })`** takes the event schemas themselves, the same tagged structs and classes `AppEvent.make` took. `AssistantEvent.AppEventSchema` is their type.
  - **What comes in through `submit` wakes a turn; what a turn appends never does.** An app event submitted from outside a turn (a workflow, a webhook, your API) is an input, like a user's message. One a turn writes with `chat.append`, like a summary or a note that the daily budget ran out, wakes nothing. The log marks a submitted event (`"~effect-assistant/input": true` in its stored JSON, which decoding drops, and `AssistantEvent.isAppInput` reads), so a restart resumes the same chats. The handler decides what each turn does: run the loop, or record something and return `Stream.empty`.
  - **A turn that doesn't run the loop is never failed for being silent.** The check that ends a turn with `TurnFailed` ("I finished without sending a reply.") when the user's latest input got no reply now applies only to turns that ran `turn.loop` or `turn.replyIfOwed`, where it works as before. A handler that ends the turn without them decided that itself, and the turn completes.
  - **The model reads an app event only as a history view maps it.** App events reach the view (the loop's `history`, `turn.history(view)`, `Compaction.since`) as entries, as before; map those the model should read to a `Prompt.Message`, and an app event's entry left in is dropped. A message the view puts in stands where it is, and waits like an input for open calls' results and for the model's next read, so a call keeps its result right after it.
  - **`ChatView` is `Timeline`: the chat as its user sees it.** A `Timeline.Timeline` holds `items` (messages, and the app events it shows), the activity, and whether the last turn failed or the chat was deleted; the server streams `Timeline.Change`s and the client folds them.
  - **The timeline shows the app events the server names, typed.** `Timeline.changes(MyAssistant, { show: [DailyBudgetReached] })` adds an item for each of those, and leaves out the app's other events; without `show`, none reach the client. Such an item is a `Timeline.EventItem`: its `_tag` is the event's, the decoded event is in `event`, and the item's `id` (fixed per entry) and `at` sit beside it. `Timeline.Change([DailyBudgetReached])` is the RPC's success schema for those changes, in JSON, with each item decoded by its event's schema, so the client needs no definition: `Timeline.fold` (or `Timeline.apply`) folds them into a `Timeline.Timeline<DailyBudgetReached>`, and `Match.valueTags(item, { UserMessage, AssistantMessage, DailyBudgetReached: (budget) => ... })` is exhaustive over them. A handler that shows an event its RPC's schema doesn't name doesn't compile, and a change decodes without an item whose event the schema doesn't name or can't decode.

  Breaking changes, and how to migrate:

  - **`AppEvent` is gone.** `events: [AppEvent.make(OrderPlaced, { wakes: true, render })]` becomes `events: [OrderPlaced]`. `AppEvent.EventSchema` is `AssistantEvent.AppEventSchema`, and `Assistant.events` holds the schemas.
  - **`wakes`**: an event registered with `wakes: true` wakes a turn when it is submitted with `assistant.submit(chatId, event)`, as background work already does. An event a turn appends never wakes one, even one that did with `wakes: true`. An app event stored by 0.2 has no mark, so it wakes nothing after the upgrade; a chat with one no turn has read yet gets its turn from the next input.
  - **`render`** moves to the history view: `turn.loop({ instructions, history: (entries) => entries.map((entry) => entry.event instanceof OrderPlaced ? Prompt.userMessage({ content: [Prompt.textPart({ text: render(entry.event) })] }) : entry) })`. With `Compaction.since`, map after it: `history: (entries) => Compaction.since(isSummary)(entries).map(withNotes)`. An event that relied on the default `"json"` rendering needs a mapping too, or the model doesn't read it.
  - **`ChatView` is `Timeline`.** Import `Timeline` (`effect-assistant/Timeline`), and rename: `ChatView.View` → `Timeline.Timeline`, its `messages` → `items` (on the wire too), `ChatView.Message` → `Timeline.Item`, `ChatView.Update` → `Timeline.Change`, `ChatView.updates` → `Timeline.changes` (`UpdatesOptions` → `ChangesOptions`). `empty`, `apply`, `isIdle`, `fromEntries`, `Definition`, `BlockStatus`, `Block`, `UserMessage`, `AssistantMessage`, and `Activity` keep their names, in `Timeline`. `BlockKit.toClient` renders a `Timeline.AssistantMessage`.
  - **`Timeline.Change` is a schema constructor.** `success: ChatView.Update` becomes `success: Timeline.Change()`, or `Timeline.Change([...])` with the events `show` names on the server. `Timeline.Item<Events>` includes an item per shown event, so code that reads `item.text` narrows to `UserMessage` and `AssistantMessage` first.
  - **Folding a stream of changes**: `Stream.scan(() => ChatView.empty, ChatView.apply)` becomes `changes.pipe(Timeline.fold)`, which types the timeline with the changes' events. `Timeline.apply(timeline, change)` stays for folding one at a time.
  - **`Timeline.Timeline` and `Timeline.Item` are types, not schemas.** An RPC that returned a whole `ChatView.View` returns `Timeline.snapshot(entries, MyAssistant, { show })`, a change, with `Timeline.Change([...])` as its schema, and the client applies it to `Timeline.empty`.
  - **`Timeline.fromEntries(entries, MyAssistant, { show })`** replaces `ChatView.fromEntries(entries, { wakes })`, typed with the events shown; `fromEntries(entries)` shows none. `Timeline.Definition<Events>` is `{ events, Entry }`, which an assistant fits, and `show` takes only its events; `ChatView.Options` is gone. The timeline shows a turn as working once it starts, or from the user's input.
  - **`AssistantActivity.apply` and `fromEntries`** take no options: an app event counts as an input when the log marks it so, as `ChatLog.read` returns it. `AssistantActivity.Options` is gone.
  - **A handler that runs no loop**, and relied on the silent-turn check to fail a turn with no reply, sends the reply itself or fails the turn.

- 3779f69: A web server reaches the cluster's chats without a log of its own, and a skill is offered only to a loop that has its tools.

  - **`AssistantEngine.layerClusterClient`** reaches chats that run as cluster entities elsewhere, and runs none itself. It needs only `Sharding`, no `ChatLog`: provide it to `MyAssistant.layerClient` in a process that only submits, subscribes, and deletes, like a web server in front of the runners that use `AssistantEngine.layerCluster`. An assistant's `toLayer` can't register with it: building one dies, saying so.
  - **`Skill.make(name, { description, instructions, tools })`** takes the tools a skill's instructions use. A loop whose toolkit lacks any of them, matched by name, leaves the skill out of its catalog and of `load_skill`, so a handler that gives each user the tools their role allows can pass every skill, and the model is never sent after a call it can't make. The assistant's own tools count; a tool only `ToolDiscovery` finds doesn't. A skill without `tools` is offered as before. This holds for `turn.loop` and a specialist's `run.loop`.

## 0.2.0

### Minor Changes

- 0be9944: The library no longer owns approvals: `Decision` is gone, and so are parked tool calls. Who acts decides how the user is involved:

  - **The assistant acts**: it calls a tool with final values. A tool that changes things stays safe to run twice with `AssistantToolCall.idempotencyKey`, for example as a workflow's idempotency key.
  - **The user acts**: a block without an `answer` schema shows what to do, and its button calls your app's own API (an RPC, a route) with exactly the props it shows. The API does the work and tells the chat with one of your events, registered with `AppEvent.make(schema, { wakes: true })` and stored with `assistant.submit(chatId, event)`, so the assistant follows up.
  - **The user answers**: a block with an `answer` schema, whose `BlockAnswer` the model reads. The user may also just type.

  A tool with Effect's `needsApproval` set is refused, never run: a loop with one (`turn.loop`, `AssistantLoop.run` and `step`, a specialist's `run.loop`) fails before it calls the model, naming the tools, and so a turn fails and a specialist's run reports `failed`. `ToolDiscovery.layer` over a catalog with one fails when it's built.

  Breaking changes, and how to migrate:

  - **`Decision` and `DecisionId` are gone**, and so are `AssistantEvent.DecisionOutcome`, `CallOrigin`, `DecisionRequested`, and `DecisionResolved`. `AssistantLoop.Event` is a `ModelOutput`, a `ToolStarted`, or a `ToolResult`. A log written by 0.1 reads its decision events as app events the assistant didn't register, and a call still parked there has no result, so the chat's next turn runs it like a call a crash cut off: with the tool taken out of the toolkit, it fails as a tool that doesn't exist; a tool you keep runs it.
  - **`needsApproval` + `Decision.block`**: remove `needsApproval` from the tool and `Decision.block` from the kit. If the assistant may do it alone, keep the tool: the model calls it with final values. Otherwise, take the tool out of the toolkit, and give the assistant a block without an answer that shows the work (`Block.make("order_draft", { description, props })`, its props what the tool's params were, plus what the user should see, like a total). Its button calls your API, which checks again (the budget may have moved), does the work once per block (key it on the chat and the block's message id, which a renderer now gets as `messageId`), and submits a waking event like `OrderPlaced`. Tell the model in the block's description that only the user does it, with the button.
  - **`Decision.durable` and `Decision.request`**, from before 0.1.0 (they were removed when decisions became tool calls only), have the same replacement. Work that needs the user reports it with a waking event that says what it needs, and the assistant shows a block: one with an `answer` schema for a question, or one without whose button calls your API for a commitment. The API resumes the work (for a workflow waiting on a `DurableDeferred`, it completes it) and tells the chat.
  - **`ChatView.PendingDecision` is gone, and so is a block's `decisions`** in the view. `BlockKit.RenderArgs` has no `decisions`, and `BlockKit.closeStale` closes every stale block.
  - **`Compaction.openItems`** lists blocks the user hasn't answered and specialists still working; there are no decisions waiting.
  - **`ToolDiscovery`'s `execute_tool`** no longer fails with reason `"NeedsDecision"`: the layer refuses such tools when it's built.

### Patch Changes

- c93fb2d: The published package names its type declarations in `types`, so npm shows it ships its own types.

## 0.1.0

### Minor Changes

- e13d0b1: The app's events are registered with how they read and whether they wake a turn, a chat can be deleted, and a chat client gets only what its user sees.

  - **`AppEvent.make(schema, { wakes, render })`** registers one of the app's events with an assistant (`Assistant.make(name, { events: [...] })`). One with `wakes: true` is an input: storing it starts a turn, like what a workflow or a webhook reports. `render` is how the model reads it (a function of the event, or `"json"`, the default for one that wakes a turn); one that doesn't wake a turn and has no `render` is the app's bookkeeping, read only when a history view puts it in. `submit` and `turn.append` take only registered events (anything else is a type error), and the chat stores no app event its assistant didn't register.
  - **`MyAssistant.delete(chatId)`** deletes a chat: its log (`ChatLog.delete`, which also remembers the chat was deleted; `isDeleted` says whether it was), the turn and specialist runs working in it, and its subscribers' streams. After that the chat takes nothing, also after a restart: a later `submit`, a run's report, or a workflow's event is dropped quietly. A workflow waiting on one of its decisions gets `"declined"`. `ChatLog.layerSql` keeps deleted chats in a `chat_log_deleted` table, which it creates.
  - **`MyAssistant.subscribeView(chatId, { after })`** streams the chat as its user sees it (`ChatView`): the user's and the assistant's messages, each block's status (`open`, `answered`, `closed`) and answer, a decision block's decisions with their previews and outcomes, what works (the assistant, and which specialists), and whether the last turn failed. Nothing internal: no model output, tool calls or results, app events, or failure messages. `ChatView.Update` and `ChatView.View` are schemas for an RPC; `ChatView.apply` folds updates on the client (applying one twice changes nothing); `ChatView.fromEntries` and `ChatView.updates` fold a log on the server. `AssistantActivity.apply` and `fromEntries` take `{ wakes }`, so the app's waking events count as inputs there too.

  Breaking changes, and how to migrate:

  - **`AssistantEvent.Fact` is gone.** A fact is a registered event with `wakes: true`: give it a schema of its own (a `Schema.TaggedClass` with the fields its `payload` had, and an `id: InputId.InputId` to keep it idempotent), register it with `AppEvent.make(Schema, { wakes: true, render })`, where `render` says what its `<fact>` text said, and submit it instead: `MyAssistant.submit(chatId, OrderShipped.make({ id, ... }))`. `AssistantEvent.Input` and `isInput` no longer have facts.
  - **`events` takes registered events, and `inputs` is gone.** `Assistant.make(name, { events: [Summary], inputs: [FileUploaded] })` becomes `{ events: [AppEvent.make(Summary), AppEvent.make(FileUploaded, { wakes: true })] }`. An old input reads as before (`"json"`: its tag and fields in JSON). `Assistant.EventSchema` is `AppEvent.EventSchema`, and `Assistant.Assistant` has three type parameters (`Name`, `Specs`, `Events`).
  - **`AssistantEvent.AppEvent` (the stored form) is `AssistantEvent.StoredAppEvent`.**
  - **Clients use the view, not the log.** `subscribe` streams the whole log, and stays, for server-side code, tests, and debugging; don't send it to a client. An RPC that streamed `AssistantEvent.Entry` or `MyAssistant.Entry` to a chat client streams `ChatView.Update` from `subscribeView` instead, and the client folds with `ChatView.apply` from `ChatView.empty`, instead of `BlockKit.apply`, `Decision.nextStates`, and `AssistantActivity.apply` over entries.
  - **`BlockKit.toClient` renders a view's messages.** Its renderer takes a `ChatView.AssistantMessage` and `{ respond }`: a block's state comes with the message, so `RenderOptions.state` is gone. A renderer gets `decisions` (for the decision block: each one's preview and outcome), so a decision block needs no `Decision.states` on the client.
  - **`ChatLog` has `delete` and `isDeleted`**, and so does the `Storage` a custom `ChatLog.make` is built on (`delete(chatId, at)`: remove the entries and keep a record that the chat was deleted). `AssistantEngine` has `delete`.

- b22c2c2: The app's own events and inputs are stored as themselves, in their schema's JSON form: `Assistant.make(name, { events, inputs })` takes tagged schemas. Inputs wake a turn, `submit` takes them, and the model reads them; `turn.entries` and `subscribe` decode both to their types, and `MyAssistant.Entry` is the schema for an RPC that streams them. `AssistantEvent.Custom` is gone. `AssistantHistory` is gone too: a history view (`turn.loop({ history })`, `turn.history(view)`) picks which entries the model reads and what goes with them. `ClientInput` is `UserInput` (and `isUserInput`): the inputs a turn owes a reply. `AssistantEvent.Entry` is a struct now, not a class.
- 79c240e: An open chat reads its log once and keeps its entries in memory, so a turn no longer reads the log. `ChatLog.read(chatId, { after })` and `subscribe(chatId, { after })` read or stream only what comes after a `seq`, for a client that reconnects.
- 015c766: An assistant is a service you yield, and code in a chat uses the chat itself.

  - **`const assistant = yield* MyAssistant`** gives `submit`, `subscribe`, `subscribeView`, and `delete`. `MyAssistant.toLayer(...)` registers the handler and provides the service; `MyAssistant.layerClient` provides the service only, for a process that reaches chats another one runs. Calling an assistant you didn't provide is a type error, not an "isn't registered" defect at runtime.
  - **`yield* CurrentChat`** is the chat that code runs in: its `chatId`, its `entries` (the assistant's own events decoded), and `append(...events)` (encoded). A handler, a tool, and a specialist's run all get it.

  Breaking changes, and how to migrate:

  - `MyAssistant.submit(chatId, input)` becomes `(yield* MyAssistant).submit(chatId, input)`, or `MyAssistant.use((assistant) => assistant.submit(...))`; the same for `subscribe`, `subscribeView`, and `delete`. Provide the assistant's layer with `Layer.provideMerge` where those callers run.
  - `turn.entries` and `turn.append` are gone: `const chat = yield* CurrentChat.CurrentChat`, then `chat.entries` and `chat.append(...)`. Entries carry your events decoded but untyped: read them with `Schema.is(MyEvent)` or `instanceof`.
  - `CurrentChat.append` takes events as arguments, not an array, and returns nothing.

- 617086c: `CurrentChat` is the chat code runs in: its id, its entries, and its writer. It replaces `AssistantTurn`, and turns no longer get the `ChatLog`. Ids are UUIDs from Effect's `Random`: `ChatId.make`, `RunId.make`, and `InputId.make` are Effects, and `InputId.fromKey` takes a key as the id. `Runner.spawn` takes no turn, and block props and answers are service-free codecs (`Block.Codec`).
- 69edce0: The app says which chats exist, and deleting a chat keeps its log.

  - **`Chats`**: `get(chatId)` returns the chat, or fails with `GetChatError` (`reason`: `"NotFound"` or `"Deleted"`). The assistant asks it before `submit` sends, when the chat stores an input, and before every model call. A chat it says is deleted is deleted then, as by `delete`. By default every chat exists from its first input.
  - **`ChatDeleted`**: `MyAssistant.delete(chatId)` appends it, stops what works in the chat, and ends its subscribers' streams after the event. `ChatView` has `deleted`, and `AssistantActivity` says nothing works after it.

  Breaking changes, and how to migrate:

  - **`submit` can fail** with `GetChatError`, when your `Chats` says so. Without `Chats` it never does.
  - **The log is kept.** `ChatLog`'s `delete` and `isDeleted` are gone, and so are `Storage`'s; `ChatLog.layerSql` no longer needs `ChatLog.DeletedChats`, which is gone. Where you kept that record, implement `Chats.get` on it instead. Removing old logs is the app's.
  - **`ChatView.View` and `Update` have `deleted`.** A client that builds them by hand adds it.

- a3a1685: Decisions: what the user approves or declines, like placing an order. A tool with Effect's `needsApproval` (static, or a function of its params) is parked when the model calls it instead of running: its preview runs (`AssistantLoop.tools(toolkit, { previews })`, an Effect of the params), and the model reads that the call waits, with the decision's id and the preview. Running work asks with `Decision.durable` (a workflow waits on a `DurableDeferred` until the answer) or `Decision.request` from any app code (`Decision.outcome` waits for it). The library never asks the user: the model sends a message with the decision block, `Decision.block`, for one decision or several, and only its answer decides. An approved call runs at the turn's next step exactly as the model made it, with the same call id; a declined one never runs. The chat takes answers one at a time and refuses one whose block is closed, that doesn't decide exactly the decisions its block asks for, or that decides one already decided. New events: `DecisionRequested` (a work request is an input) and `DecisionResolved`; `Decision.states` folds them for a client, and `DecisionId` is the id's schema.

  Breaking changes, and how to migrate:

  - **More events.** `AssistantEvent.AssistantEvent` has `DecisionRequested` and `DecisionResolved`, `AssistantEvent.Input` has `DecisionRequested`, and `AssistantLoop.Event` (what a loop emits, and a handler returns) has `DecisionRequested`. An exhaustive match over any of them adds the new cases; a custom specialist or loop that records events passes a `DecisionRequested` through like a `ToolResult`.
  - **`needsApproval` is honored.** A tool that sets it no longer runs when the model calls it: it waits for the user's decision, and an assistant whose loop has such a tool needs `Decision.block` in its blocks (its turn fails, saying so, otherwise). A specialist's call to one fails (kind `needs_decision`), and `execute_tool` refuses one.
  - **Approvals move to decisions.** A workflow that reported an approval token in a fact, for a tool to complete once the user answered a confirm block, asks with `Decision.durable` instead and gets the outcome; the tool and the token go. Provide the `WorkflowEngine` to the assistant's layer, so the answer can complete the workflow's deferred.

- 6729585: `ChatId.make()` and `InputId.make()` are functions returning an Effect (still on Effect's `Random`, so tests can seed them): `yield* ChatId.make()`. `UserMessage.make({ text })` gets a new id when none is given; pass the client's own to make a retried send store the message once.
- ea48ff7: The first release: assistants, the agent loop, specialists, skills, UI blocks, the chat log (memory and SQL), and the memory and cluster engines.
- de71956: Renames and small API fixes, with no compatibility aliases:

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

- 8f7c260: The library runs on Effect's AI modules (`effect/unstable/ai`) instead of effect-uai: any `LanguageModel` provider, native `Tool`s and toolkits, and `Prompt`/`Response` parts in history and in the log. `@effect-uai/core` isn't a peer dependency any more. The loop still makes one model call per step and runs the calls itself, each stored as started before it runs; the agent's model output, tool calls, and results stay its own work, and the user sees only `send_user_message`.

  Breaking changes, and how to migrate:

  - **No `model` option.** `turn.loop`, `run.loop`, `turn.replyIfOwed`, `AssistantLoop.step`, and `AssistantLoop.stream` call the `LanguageModel` in context. Provide `AnthropicLanguageModel.model("claude-sonnet-5")` (with `AnthropicClient.layer({ apiKey })` and an `HttpClient`) where you provided `Anthropic.layer({ apiKey })`. For a specialist on another model, provide one to its `toLayer(...)`.
  - **Prompt caching is the provider's option.** `Anthropic.layer({ promptCaching: true })` becomes `AnthropicLanguageModel.model(name, { cache_control: { type: "ephemeral" } })`, the same request-level breakpoint. Anthropic can refuse many strict tools ("compiled grammar is too large"): `strictJsonSchema: false` turns them off.
  - **Native tools.** `Tool.make({ name, description, inputSchema, run })` becomes `Tool.make(name, { description, parameters, success, failure, dependencies })` from `effect/unstable/ai/Tool` with a handler (`Toolkit.make(...).toLayer(handlers)`). Declare `success` (the default is `Schema.Void`). A handler's call-time services (`CurrentChat`, `AssistantToolCall`, your `CurrentUser`) are its tool's `dependencies`; its layer's services, it yields in the layer's build.
  - **`AssistantLoop.Tools`.** The loops' `toolkit` option, `turn.tools`, `ToolDiscovery.make`, and `Skill.toolkit` take or return `AssistantLoop.Tools`. Make them with `AssistantLoop.tools(yield* MyToolkit)`, `AssistantLoop.tools(MyToolkit, handlers)`, or `AssistantLoop.tools(MyToolkit)`; replace `{ ...a, ...b }` and `Toolkit.compose(a, b)` with `AssistantLoop.merge(a, b)`.
  - **`ToolFailure`.** `Tool.fail(message, { kind })` becomes `ToolFailure.fail(message, { kind })`, with `failure: ToolFailure.ToolFailure` on the tool. Every failure of a tool, and params that don't fit its schema (kind `ToolParameterValidationError`), is a result the model reads; `AssistantLoop.ToolErrors` is gone, since only a defect fails the loop.
  - **History is `Prompt.Message`s.** `turn.history()`, `run.history`, and a history view's extra items are `effect/unstable/ai/Prompt` messages: `Items.userText(text)` becomes `...Prompt.make(text).content`.
  - **Stored forms.** `ModelOutput` has `parts`, native response parts, instead of `items`, and records the step's `model`, `responseId`, `usage` (with cache reads and writes), and `durationMillis`. `ToolResult` has `outcome` (`"success"` or `"failure"`), `result` (the encoded result in JSON), and a failure's `kind`, instead of `output` text. Logs written in the old forms don't decode. `TurnStarted` has the turn's `traceId` when a tracer records it.
  - **Your own loop** uses `AssistantLoop.loop`, `value`, `next`, and `stop` instead of effect-uai's `Loop`, and `toolChoice` is `LanguageModel.ToolChoice` (`{ tool: name }` to force one).

- ed9c894: Loops take native toolkits. `turn.loop`, `run.loop`, `AssistantLoop.run`, and `AssistantLoop.step` take an Effect `Toolkit` as `toolkit`, with its handlers from the assistant's (or specialist's) layer: `toLayer` now requires the tools' handlers, so `Layer.provide(MyToolsLive)` gives them, and a missing one is a type error naming the tool. In a turn, `AssistantLoop.step` and `run` add the assistant's own tools to yours, so a loop of your own can message the user.

  Breaking changes, and how to migrate:

  - **`AssistantLoop.fromToolkit`, `merge`, `only`, `empty`, and the `Tools` type are gone.** Pass the toolkit itself (`toolkit: MyTools`) and provide its handlers' layer (`MyTools.toLayer(handlers)`); merge toolkits with `Toolkit.merge`; give a user fewer tools by building a smaller toolkit for their turn.
  - **`ToolDiscovery` is a loop option**: `turn.loop({ toolkit, catalog: BigToolkit })` gives the model `search_tools` and `execute_tool` over `catalog`.
  - **Memory's tools are a native toolkit**: `Memory.makeToolkit(scopes)` becomes `Memory.Tools` with `Memory.layerTools`, and the turn provides the scopes, `Stream.provideService(Memory.CurrentScopes, scopes)`.
  - **Previews are gone.** A parked call has no preview: `DecisionRequested` has no `preview`, and a view's decision has the call's `tool` and `params` instead. What the user sees about a call is the app's (a lookup tool the model calls first, or the client fetching what it needs).
  - **`turn.tools` and `Skill.toTools` are gone**: a loop of your own gets the assistant's tools by itself, and `skills` is a loop option.

- e12b17d: `AssistantToolCall.destructive` is gone: a call a crash cut off always runs again, with the same id. A side effect that can't take `AssistantToolCall.idempotencyKey` goes in a workflow step or behind the user's approval.
- 5fb4edd: The colleague preamble is gone: `Instructions.protocol` is all the library adds to an assistant's instructions (every step is a tool call, `wait` ends the turn, messages can arrive mid-turn). The rest is where it applies: `send_user_message`'s description, and how a fact, a specialist's report, or a block answer reads in the history. The persona and what's worth telling the user are the app's prompt. The reply pass's nudge is configurable (`replyIfOwed({ nudge })`, `loop({ replyNudge })`).
- 873c9aa: Decisions are for tool calls only: `Decision.durable`, `Decision.request`, and `Decision.outcome` are removed, and so is a decision's work origin. A tool with `needsApproval` still parks its call, with its preview, until the user answers the decision block.

  Breaking changes, and how to migrate:

  - **Workflows don't ask the user.** Put `needsApproval` (and a preview) on the tool that starts the work, so the user approves before it starts. A workflow that needs something mid-way reports it as one of your own events that wakes a turn, and the assistant asks.
  - **`DecisionRequested` isn't an input.** `submit` no longer takes one, `AssistantEvent.Input` doesn't include it, and its `origin` is always the parked call (no `Work` origin, no `token`). Logs with a work-origin request don't decode.
  - **The assistant's layer no longer uses a `WorkflowEngine`.**

- dcdc60e: `send_user_message` takes a required `wait`: `true` makes it the last message for now and ends the turn, so a reply no longer needs a separate `wait` call (`wait` stays, for ending a turn with nothing to say). A step whose calls failed doesn't end the turn: a message that failed with `wait: true` (props that don't fit its block, say) comes back to the model instead of ending the turn unsent. `load_skill` is asked for in the same step as the first lookups. Submitting an input again while the first submit is still storing it stores it once.
- 0b50e54: Memory is a toolkit over a store the app implements. `Memory.MemoryStore` has `facts`, `remember`, `forget`, and `recall`, each given the chat it's for: the app decides whose facts that means. `Memory.Tools` (with `Memory.layerTools`) call it for the chat they run in, and `Memory.render(facts)` writes the facts for a turn's instructions.

  Breaking changes, and how to migrate:

  - **Scopes are gone**, and so are `Memory.CurrentScopes`, `Memory.Scopes`, and `Memory.facts(scopes)`: implement `MemoryStore` and map a chat to its owner yourself.
  - **A fact is `{ id, text, expiresAt? }`.** `kind` is gone: a short-lived fact has an `expiresAt` (the model passes `until`), a lasting one doesn't. `log` lines and `Memory.log` are gone: keep them in your store, from your own code.
  - **`Memory.layerSql` is gone**: the store is yours. `Memory.layerMemory` stays, for tests and local runs.
  - **`Memory.render(facts)` returns a string**, empty when there are none.

- e1d7e04: Sync with the version running in production, on effect 4.0.0 (AI, cluster, and workflow modules moved out of `effect/unstable/*`).

  New: `Memory` (facts across chats, with `remember` / `forget` / `recall` tools) and `Compaction` (a summary in place of a long chat's start).

  Breaking changes, and how to migrate:

  - **`AssistantLoop.tools` is `AssistantLoop.fromToolkit`**, with the same arguments. `Skill.toolkit` is `Skill.toTools`, and `Decision.states` is `Decision.fromEntries`.
  - **`ChatLog.layerSql` creates no tables.** Create `chat_log` (`chat_id`, `seq`, `at`, `event`; primary key `chat_id, seq`) in a migration.
  - **effect 4.0.0**: imports from `effect/unstable/ai/*`, `effect/unstable/cluster/*`, and so on become `effect/ai/*`, `effect/cluster/*`.

- 7ea8bb5: `ToolDiscovery` is back as a module, and native: `ToolDiscovery.make(catalog)` returns a toolkit (`search_tools` and `execute_tool`) to merge with yours, and its handlers' layer, which needs the catalog's handlers. What the catalog's tools use at call time is `execute_tool`'s requirement, so the turn provides it as for any tool. A tool run through `execute_tool` gets a call id made from that call's, stable when a crash runs it again.

  Breaking: the loop's `catalog` option is gone; use `toolkit: Toolkit.merge(MyTools, ToolDiscovery.make(Catalog).toolkit)` and provide its `layer`.

- 8f745c0: `yield* MyAssistant.Chat` is the chat an assistant's turn runs in, typed with its events: its `entries` carry them typed (narrow with `Predicate.isTagged(event, "Summary")`), and its `append` takes only them and the library's, so an unregistered event is a type error. The handler, its build, and any tool its turns run get it; `toLayer` counts it as provided by the turn. `CurrentChat` stays for code that doesn't know the assistant, like a shared tool or a specialist's run.
- 581f67a: The chat's view is a utility over `subscribe`, not a method of the assistant's service. `subscribeView` is removed from `yield* MyAssistant` (and from `MyAssistant.layerClient`), with no compatibility alias.

  Before:

  ```ts
  const view = (chatId: ChatId.ChatId, after?: number) =>
    MyAssistant.useSync((assistant) => assistant.subscribeView(chatId, { after }))
  ```

  After:

  ```ts
  const view = (chatId: ChatId.ChatId, after?: number) =>
    MyAssistant.useSync((assistant) => assistant.subscribe(chatId).pipe(ChatView.updates(MyAssistant, { after })))
  ```

  - **`ChatView.updates(definition, options?)`** is dual: `entries.pipe(ChatView.updates(MyAssistant, { after }))` or `ChatView.updates(entries, MyAssistant, { after })`. It reads which of the app's events wake a turn from the definition's `events`, so it takes the assistant, not `{ wakes }`. Any value with `events: ReadonlyArray<{ tag, wakes }>` fits (`ChatView.Definition`).
  - **`after` goes to `ChatView.updates`, not to `subscribe`.** The fold reads the whole log from seq 0, because a message's view depends on earlier entries (a block answered later, a decision made later), and only skips emitting the updates up to `after`. `subscribe(chatId, { after })` would give it half a log.
  - `ChatView.updates(entries, { wakes, after })` is gone; pass the assistant's definition instead.

### Patch Changes

- 35820f8: Follow Effect's source conventions: every export has `@category` and `@since`, internals are `@internal` with terse why-comments. Library events are recognized by their `_tag`, not their schema identifier.
