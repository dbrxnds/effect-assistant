# effect-assistant

A chat assistant on [Effect](https://effect.website) that behaves like a
colleague. It keeps an append-only event log per chat, runs an
interruptible agent loop over it, and talks to the user only through a
`send_user_message` tool. It also supports specialists, skills, UI blocks,
memory, and compaction. It runs in memory or as one Effect
Cluster entity per chat.

```bash
pnpm add effect-assistant effect@^4.0.0 @effect/ai-anthropic@^4.0.0
```

The [README on GitHub](https://github.com/dbrxnds/effect-assistant#readme)
has the simplest setup and the more extensive ones. The
[docs](https://github.com/dbrxnds/effect-assistant/tree/main/apps/docs) have
a guide per topic and the API reference.

```bash
pnpm --filter effect-assistant test            # the mechanics, on a scripted model
pnpm --filter effect-assistant test:contract   # against a real model (ANTHROPIC_API_KEY in .env.local)
pnpm --filter effect-assistant build           # dist, with declarations and source maps
```
