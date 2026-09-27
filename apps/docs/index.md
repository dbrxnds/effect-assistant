---
layout: home

hero:
  name: effect-assistant
  text: A colleague assistant on Effect
  tagline: Not a request/response chatbot. It works in the background, picks up messages mid-task, and decides what you need to hear.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: How it works
      link: /guide/turns

features:
  - title: One log per chat
    details: Every message, model call, tool result, and workflow update is an event in an append-only log. The chat UI gets what its user sees of it; the model's history is rebuilt from it.
  - title: Interruptible
    details: Submitting returns at once. The assistant reads the log before every model call, so a message sent mid-task joins the running turn.
  - title: It decides what you hear
    details: The assistant talks only through a send_user_message tool. Workflow updates and specialist results arrive as events it reads, and the assistant chooses whether to tell you.
  - title: Specialists, skills, blocks
    details: Hand work to background specialists, load playbooks on demand, and put buttons or inputs in messages when a structured answer is easier.
  - title: Memory or cluster
    details: Run in-process for tests, or one cluster entity per chat, where a crash mid-turn resumes on redelivery.
  - title: Observable
    details: Turns, model calls, and tool calls are OpenTelemetry GenAI spans, ready for Langfuse or any LLM tracing tool.
---
