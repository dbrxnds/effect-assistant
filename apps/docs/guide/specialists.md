# Specialists

A [`Specialist`](/api/Specialist) is a focused agent with its own
instructions, skills, and tools. The assistant hands it work and keeps chatting;
the answer comes back as a fact.

A specialist has two parts, like a workflow:

- a **definition**, with `Specialist.make`: its name, and when to use it
  (the assistant sees this).
- a **handler**, with `toLayer`: a function of the run that returns its loop,
  usually `run.loop({ model, instructions, toolkit })`.

**Example** (A research specialist)

```ts
import * as Toolkit from "@effect-uai/core/Toolkit"
import { Assistant, Specialist } from "effect-assistant"
import * as Layer from "effect/Layer"

const Research = Specialist.make("research", {
  description: "Researches past campaigns and orders. Give it the question and any context."
})

const ResearchLive = Research.toLayer((run) =>
  run.loop({
    model: "claude-sonnet-5",
    instructions: "Answer with the findings and numbers the colleague needs, in a few short lines.",
    toolkit: Toolkit.make(similarCampaigns, orderHistory)
  })
)

// The assistant lists it, and its toLayer needs ResearchLive.
const MyAssistant = Assistant.make("my-assistant", { specialists: [Research] })

const MyAssistantLive = MyAssistant.toLayer(handler).pipe(Layer.provide(ResearchLive))
```

## The specialist tools

An assistant's specialists are a fixed catalog: their names are an enum in
the tool schema, and their descriptions are in the tool text. The assistant
gets three tools to work with them.

### `spawn_specialist`

```
spawn_specialist({ kind, goal, context?, successCriteria?, report?, limits? })
```

Starts a run with a [brief](/api/Specialist#brief) and returns its `runId`.
The specialist can't see the chat, so the assistant writes a self-contained brief.
The run works in the background, and its report, the last text its model
wrote, arrives as a `SpecialistFinished` input. The model reads it as a
`<specialist>` block: its status (answered, failed, stopped, or cut off), how
long ago it was started and for what, whether the user has written since,
and the report. A quick question usually comes back within the same turn; for
slow work the assistant tells the user in one line and follows up. While runs
work, each turn's prompt lists them under "Running now".

### `message_specialist`

```
message_specialist({ runId, message })
```

- A **running** run reads the message at its next step: that's steering
  ("also find the 2025 one").
- A **finished** run continues with everything it already found: that's a
  follow-up ("which province is it in?").

Both come in through `run.history`, which the loop reads before every model
call. A handler that builds its own history instead won't see them.

### `stop_specialist`

```
stop_specialist({ runId })
```

Interrupts a running run. It posts no answer.

## The handler

The build Effect runs once per chat activation, like an assistant's (with
`AssistantChat`), and the function runs for each brief (and each follow-up),
so instructions, tools, the model, and limits are just code.

**Example** (At most three reports at a time)

```ts
import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"

const Analyst = Specialist.make("analyst", {
  description: "Writes reports on spend, budgets, and campaigns."
})

const AnalystLive = Analyst.toLayer(Effect.gen(function*() {
  const permits = yield* Semaphore.make(3) // once, for every run

  return (run) =>
    Stream.unwrap(Effect.gen(function*() {
      // Held until the run's stream ends; waits while three runs are going.
      yield* Effect.acquireRelease(permits.take(1), () => permits.release(1))

      return run.loop({
        model: "claude-haiku-4-5", // any model the LanguageModel layer serves
        instructions: "Write the report the colleague asked for, with the numbers.",
        toolkit: Toolkit.make(spendReport),
        maxSteps: 12 // model calls per brief; default 8
      })
    }))
}))
```

- `run.loop` takes `model`, `instructions`, `toolkit`, `skills` (its own
  [catalog](./skills)), and `maxSteps`.
- The handler may use the run's services (`Specialist.RunServices`) and what
  its build Effect required, as an assistant's handler does (see
  [what a handler may use](./assistant#what-a-handler-may-use)).
- A run waiting for a permit already counts as working (it has
  `SpecialistStarted`), so a chat UI shows it as busy.

A run works in the chat of the turn that spawned it (`run.chatId`), so its
handler looks up the same user the assistant's does (see
[chats and users](./chats#specialists)). Its answer is written to that chat's
log as a fact and gets a turn there.

## Runs live with their chat

Runs are fibers next to the chat's turns: with `AssistantEngine.layerCluster`,
in the chat's entity, which keeps itself alive while a run (or a turn for its
answer) works. A finished run stays warm for 15 minutes for follow-ups.

Runs aren't durable. That's deliberate: a specialist is a quick helper, not
a durable job. A run cut off by a shutdown answers that it was cut off, so
the assistant can spawn it again; with the cluster engine, the chat's entity
starts again after the restart and runs a turn for that answer. For durable
work, start a [workflow](./facts#long-running-work) from a tool instead.

Every time a run starts working (spawned, or continued by a follow-up) the
chat's log gets `SpecialistStarted`, and when it stops, however it stops,
`SpecialistFinished`. A run the assistant stopped itself starts no turn. A process that dies without shutting down (killed, out of
memory) can't write either, and its runs stay open in the log.
