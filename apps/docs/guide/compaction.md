# Compaction

Every model call reads the chat's history, so a long chat gets slower and
costs more with every turn, until it no longer fits the model's context.
Compaction lets the model read a summary instead of everything before it.
The chat's log keeps everything: the user's view, blocks and records don't
change, only what the model reads gets shorter.

The library doesn't compact on its own. When to compact, which model writes
the summary, and what goes in it are the app's choices, and the
[loop](./loops) gives a handler what it needs:

- [`Compaction.inputTokens(entries)`](/api/Compaction): how big the last
  model call's prompt was, from the usage every `ModelOutput` stores.
- `turn.entries`: the chat's entries. Reading them doesn't count as
  handling them, so an input that arrives while you summarize gets the next
  turn.
- Your own model call over your own rendering of those entries, like a
  transcript of what was said and done, with `LanguageModel.generateText`.
- `turn.append(summary)`: stores the summary as one of your own
  [events](./app-events), one that doesn't wake a turn.
- `Compaction.since(isSummary)`: a history view that starts at the last
  summary.

## A summary event

The summary is your own event, with its text and the last `seq` it covers:

```ts
import * as Schema from "effect/Schema"
import { AppEvent, Assistant, Compaction } from "effect-assistant"

class Summary extends Schema.TaggedClass<Summary>()("Summary", {
  text: Schema.String,
  throughSeq: Schema.Int
}) {}

const MyAssistant = Assistant.make("my-assistant", { events: [AppEvent.make(Summary)] })

const history = Compaction.since(Schema.is(Summary))
```

`throughSeq` is what the summary covers. An input that arrives while the
summary is written gets a later `seq`, so the model still reads it.

## Compacting after a turn

The handler runs its loop, then checks how big the prompt got, and
summarizes past a threshold:

```ts
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"

const MyAssistantLive = MyAssistant.toLayer((turn) => {
  const options = { instructions: "You help a small team.", history }

  const compact = Effect.gen(function* () {
    const entries = yield* turn.entries
    if (Compaction.inputTokens(entries) < 100_000) return

    const { text } = yield* LanguageModel.generateText({
      prompt: [
        {
          role: "system",
          content:
            "Summarize this chat for yourself: what the user wants, what was decided and why, the ids and references that matter, and what is in progress."
        },
        { role: "user", content: transcript(entries) }
      ]
    })

    yield* turn.append(Summary.make({ text, throughSeq: entries.at(-1)?.seq ?? 0 }))
  })

  return Stream.concat(turn.loop(options), Stream.drain(Stream.fromEffect(compact)))
})
```

`transcript` is yours: what the user and the assistant said, what it did and
what came back, shortened. Summarizing after the loop keeps it off the
user's wait: the reply has been sent, and the next turn reads the summary.
Build each new summary from the previous one and what came after it.

## What the model reads

With a summary, `Compaction.since` gives the model:

1. the summary, in `<earlier_in_this_chat>`;
2. what is still open, in `<still_open>`: decisions waiting for the user,
   blocks the user hasn't answered, and specialists still working. It is
   read from the log, not from the summary, so no summary can lose it;
3. the entries after `throughSeq`, as usual.

What a summary should never be the only record of belongs outside the chat
anyway: a draft in its own store, an order in the system it's placed in.
Your own events after the summary show as they always do.

## Thinking models

Models with thinking bind each thinking block to the conversation before it.
The view above replays nothing from before the summary, so it works with
them: the model reads the summary, and only thinking from after it.
