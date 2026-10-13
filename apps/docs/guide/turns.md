# Turns

A turn is the assistant working through a chat's new inputs: call the model,
run its tools, repeat, until it has nothing left to do.

**Example** (One turn in the log, simplified)

```
1  UserMessage       What's the weather in Oslo?
2  TurnStarted
3  ModelOutput       get_weather({ city: "Oslo" })
4  ToolResult        get_weather: { city: "Oslo", weather: "sunny, 21°C" }
5  ModelOutput       send_user_message({ text: "Sunny in Oslo, 21°C.", wait: true })
6  AssistantMessage  Sunny in Oslo, 21°C.
7  ToolResult        send_user_message: sent
8  TurnCompleted     throughSeq: 7
```

Every line is an [event](./events) in the chat's log. The user sees two of
them: their message and the assistant's.

## How a turn runs

1. `submit` appends an input (a message, a block answer, or one of your [events](./app-events)). If no turn is
   running for the chat, one starts. What a turn appends itself never starts one.
2. The handler runs the loop, usually `turn.loop(...)`. It rebuilds the
   model's history from the log, calls the model, and runs its tool calls.
   The engine records each step in the log. Then it repeats.
3. Before **every** model call, the loop reads the log again.
4. The turn ends when the model ends it (a message with `wait: true`, or
   `wait`) or makes no tool call, and nothing new arrived. A step whose
   calls failed doesn't end it: the model reads the failure first. `TurnCompleted.throughSeq` records how far it read;
   inputs after that start another turn.

One turn runs per chat at a time. The [engine](./engines) sees to it.

## Interrupting

Step 3 is what makes the assistant a colleague rather than an endpoint.
Say "also check London" while it's looking up Oslo: `submit` appends the
message, and the next model call sees it. The running turn picks it up; no
new turn starts.

A message that arrives mid-step is placed in the history so it stays
coherent (see [history order](./events#history-order)).

## The assistant talks only through tools

Every assistant has two tools of its own:

- `send_user_message({ text, wait, block? })` appends an `AssistantMessage`:
  what the user sees. With [blocks](./blocks), it can carry buttons or an
  input. `wait: true` makes it the last message for now: it ends the turn.
- `wait` ends the turn without a message.

Every step must be a tool call (`toolChoice: "required"`), so text the model
writes on its own never reaches the user. It's private reasoning.

## Telling the user, or keeping it internal

What a workflow or a webhook reports (one of your [events](./app-events),
which it submits) goes into the model's history as your history view maps it,
and reaches the user only if you let it through to the [view](./client). For
each one, the assistant decides whether the user needs to know: results,
questions, and problems get a `send_user_message`; routine progress gets just
`wait`.

So the note the model reads for an event can say what it needs rather than
what to say:

```ts
const deliveryQuestions: Assistant.HistoryView<DeliveryQuestion> = (entries) =>
  entries.map((entry) =>
    entry.event instanceof DeliveryQuestion
      ? Prompt.userMessage({
          content: [
            Prompt.textPart({
              text: `<order reference="${entry.event.reference}">Ask the user which delivery date works: ${entry.event.options.join(" or ")}.</order>`
            })
          ]
        })
      : entry
  )
```

The assistant writes the message, and can attach a [block](./blocks). Work
the user must agree to starts from a block's button, through your API (see
[involving the user](./user-involvement)).

## A reply to every message

`turn.loop` ends with `turn.replyIfOwed`: if the user's latest message has no
reply, and nothing arrived after the loop's last read, the model gets one more
pass in which it can only reply. If there's still no reply, the turn ends with
`TurnFailed` ("I finished without sending a reply."). So a user's message
always gets an answer or a visible failure, from a turn that runs the loop.

A handler that ends the turn without running the loop (`turn.loop` or
`turn.replyIfOwed`) decides itself, and its turn is never failed for being
silent. Over a daily budget, say, it records one of your events and returns
an empty stream; the user sees that event if you let it through to the
[view](./client):

```ts
const MyAssistantHandlers = MyAssistant.toLayer(
  Effect.fn(function* (turn) {
    if (yield* overBudget(turn.chatId)) {
      yield* (yield* MyAssistant.Chat).append(DailyBudgetReached.make({}))

      return Stream.empty
    }

    return turn.loop({ instructions })
  })
)
```

A message that arrived after the loop's last read owes nothing yet: the next
turn reads it with the full loop, and replies. A [custom loop](./loops#end-with-replyifowed)
ends with `turn.replyIfOwed` too.

## When a turn fails

A failing handler, a failing model call, or a tool that dies (a tool's
failures are results the model reads: see [tool failures](./tools#failures))
ends the turn with `TurnFailed`. Its
`throughSeq` covers everything stored so far, so a failing input isn't
retried forever. The next input starts a fresh turn.
