# effect-assistant

A colleague-style chat assistant library on [Effect](https://effect.website),
with a demo app built on it. You chat with the assistant like with a coworker.
It looks things up, starts durable workflows (you approve in the chat), runs
research in the background, and messages you when there's news.

| Path                        | What                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/effect-assistant` | The assistant library: event log, agent loop, specialists, skills, UI blocks, memory and cluster layers. [Docs](./apps/docs)                    |
| `packages/demo/api`         | The demo server, for a fictional company, Acme: assistant config, tools and prompts, the `CreateCampaign` workflow, RPC, and the built web app. |
| `packages/demo/shared`      | What web and API share: RPCs, UI blocks, ids, and demo data (orders, offices).                                                                  |
| `apps/web`                  | Chat UI. One RPC WebSocket per tab.                                                                                                             |
| `apps/docs`                 | Docs site for effect-assistant.                                                                                                                 |

## Run

```bash
pnpm install
pnpm dev            # API on :8787 (in memory, or Postgres with DATABASE_URL), web on :3000
pnpm docs:dev       # effect-assistant docs on :5173
pnpm check          # vp check: format, lint, and type check
pnpm test           # effect-assistant tests call the real model (ANTHROPIC_API_KEY in .env.local)
```

## Deploy

The demo runs as one Node 24 web service. Build: `pnpm install --frozen-lockfile; pnpm run build`.
Start: `pnpm start:node`. With `DATABASE_URL`, the assistant log, thread list, cluster
entities, and workflows share one Postgres pool. With `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY`, traces and prompts come from Langfuse.

Smoke test a deployment (real model, real RPC socket):

```bash
pnpm --filter @acme/demo-api smoke https://your-demo.example.com
```
