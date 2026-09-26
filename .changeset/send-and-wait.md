---
"effect-assistant": minor
---

`send_user_message` takes a required `wait`: `true` makes it the last message for now and ends the turn, so a reply no longer needs a separate `wait` call (`wait` stays, for ending a turn with nothing to say). A step whose calls failed doesn't end the turn: a message that failed with `wait: true` (props that don't fit its block, say) comes back to the model instead of ending the turn unsent. `load_skill` is asked for in the same step as the first lookups. Submitting an input again while the first submit is still storing it stores it once.
