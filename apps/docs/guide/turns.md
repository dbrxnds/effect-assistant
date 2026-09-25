# Turns

A turn is the assistant working through a chat's new inputs: call the model,
run its tools, repeat, until it has nothing left to do.

**Example** (One turn in the log, simplified)

```
1  UserMessage       What's the weather in Oslo?
2  TurnStarted
3  ModelOutput       get_weather({ city: "Oslo" })
4  ToolResult        get_weather: { city: "Oslo", weather: "sunny, 21°C" }
5  ModelOutput       send_user_message({ text: "Sunny in Oslo, 21°C." }), wait()
6  AssistantMessage  Sunny in Oslo, 21°C.
7  ToolResult        send_user_message: sent
8  ToolResult        wait: waiting
9  TurnCompleted     throughSeq: 8
```

Every line is an [event](./events) in the chat's log. The user sees two of
them: their message and the assistant's.

## How a turn runs

1. `submit` appends an input (a message, a block answer, or a fact). If no turn is
   running for the chat, one starts.
2. The handler runs the loop, usually `turn.loop(...)`. It rebuilds the
   model's history from the log, calls the model, and runs its tool calls.
   The engine records each step in the log. Then it repeats.
3. Before **every** model call, the loop reads the log again.
4. The turn ends when the model calls `wait` (or makes no tool call) and
   nothing new arrived. `TurnCompleted.throughSeq` records how far it read;
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

- `send_user_message({ text, block? })` appends an `AssistantMessage`: what
  the user sees. With [blocks](./blocks), it can carry buttons or an input.
- `wait` ends the turn.

Every step must be a tool call (`toolChoice: "required"`), so text the model
writes on its own never reaches the user. It's private reasoning.

## Telling the user, or keeping it internal

A [fact](./facts) goes into the model's history, never the chat. For each
one, the assistant decides whether the user needs to know: results,
questions, and problems get a `send_user_message`; routine progress gets just
`wait`.

So a fact can say what it needs rather than what to say:

```ts
AssistantEvent.Fact.make({
  id: InputId.make(`${runId}:awaiting_approval`),
  source: "workflow:CreateCampaign",
  payload: { status: "needs_approval", budget: 4800, next: "Get the user's approval for the budget." }
})
```

The assistant writes the message, and can attach a confirm [block](./blocks).

## A reply to every message

`turn.loop` ends with `turn.replyIfOwed`: if the user's latest message has no
reply, and nothing arrived after the loop's last read, the model gets one more
pass in which it can only reply. If there's still no reply, the turn ends with
`TurnFailed` ("I finished without sending a reply."). So a user's message
always gets an answer or a visible failure.

A message that arrived after the loop's last read owes nothing yet: the next
turn reads it with the full loop, and replies. A [custom loop](./loops#end-with-replyifowed)
ends with `turn.replyIfOwed` too.

## When a turn fails

A failing handler, or a tool that fails with anything but `Tool.fail` (see
[tool failures](./tools#failures)), ends the turn with `TurnFailed`. Its
`throughSeq` covers everything stored so far, so a failing input isn't
retried forever. The next input starts a fresh turn.
