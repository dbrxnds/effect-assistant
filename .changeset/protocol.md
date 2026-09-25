---
"effect-assistant": minor
---

The colleague preamble is gone: `Instructions.protocol` is all the library adds to an assistant's instructions (every step is a tool call, `wait` ends the turn, messages can arrive mid-turn). The rest is where it applies: `send_user_message`'s description, and how a fact, a specialist's report, or a block answer reads in the history. The persona and what's worth telling the user are the app's prompt. The reply pass's nudge is configurable (`replyIfOwed({ nudge })`, `loop({ replyNudge })`).
